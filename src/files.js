'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ansi = require('./ansi');
const { KeyReader } = require('./keys');
const { detectLanguage, computeStates, renderSlice } = require('./syntax');
const { fullscreen, requireTty, bar, fit, humanBytes } = require('./tui');

const PREVIEW_BYTES = 64 * 1024;

// --- the model --------------------------------------------------------------

class FileBrowser {
  constructor(dir, { showHidden = false } = {}) {
    this.showHidden = showHidden;
    this.filter = '';
    this.cursor = 0;
    this.top = 0;
    this.error = '';
    this.load(dir);
  }

  load(dir, focusName = null) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      this.error = `cannot open ${dir}: ${e.code || e.message}`;
      return false;
    }
    this.cwd = dir;
    this.error = '';
    this.filter = '';
    this.all = entries.map((d) => {
      const full = path.join(dir, d.name);
      let st = null;
      try { st = fs.statSync(full); } catch { /* broken link */ }
      return {
        name: d.name,
        path: full,
        isDir: st ? st.isDirectory() : false,
        isLink: d.isSymbolicLink(),
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
        exec: !!st && st.isFile() && (st.mode & 0o111) !== 0,
        hidden: d.name.startsWith('.'),
        broken: !st,
      };
    }).sort((a, b) => (a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      : a.isDir ? -1 : 1));

    const list = this.visible();
    const at = focusName ? list.findIndex((e) => e.name === focusName) : -1;
    this.cursor = at === -1 ? 0 : at;
    this.top = 0;
    return true;
  }

  visible() {
    const needle = this.filter.toLowerCase();
    return this.all.filter((e) => (this.showHidden || !e.hidden)
      && (!needle || e.name.toLowerCase().includes(needle)));
  }

  get current() { return this.visible()[this.cursor] || null; }

  move(n) {
    const count = this.visible().length;
    if (!count) { this.cursor = 0; return; }
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + n));
  }

  moveTo(i) { this.cursor = 0; this.move(i); }

  setFilter(text) {
    const keep = this.current && this.current.name;
    this.filter = text;
    const list = this.visible();
    const at = keep ? list.findIndex((e) => e.name === keep) : -1;
    this.cursor = at === -1 ? 0 : at;
  }

  toggleHidden() {
    const keep = this.current && this.current.name;
    this.showHidden = !this.showHidden;
    const at = keep ? this.visible().findIndex((e) => e.name === keep) : -1;
    this.cursor = at === -1 ? 0 : at;
  }

  // Enters the highlighted directory, or reports the file to open.
  enter() {
    const e = this.current;
    if (!e) return null;
    if (e.isDir) {
      this.load(e.path);
      return { action: 'cd' };
    }
    return { action: 'open', entry: e };
  }

  // Goes to the parent, keeping the directory we left under the cursor.
  up() {
    const parent = path.dirname(this.cwd);
    if (parent === this.cwd) return false;
    return this.load(parent, path.basename(this.cwd));
  }

  // Keeps the cursor on screen for a list `height` rows tall.
  scroll(height) {
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + height) this.top = this.cursor - height + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.visible().length - height)));
  }
}

// What the right-hand pane shows for an entry: lines of text plus a language.
function previewOf(entry, maxLines) {
  if (!entry) return { lines: [], lang: null };
  if (entry.broken) return { lines: ['(broken link)'], lang: null };

  if (entry.isDir) {
    try {
      const names = fs.readdirSync(entry.path, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.'))
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort((a, b) => a.localeCompare(b));
      if (!names.length) return { lines: ['(empty)'], lang: null };
      return { lines: names.slice(0, maxLines), lang: null, dirListing: true };
    } catch (e) {
      return { lines: [`(${e.code || 'unreadable'})`], lang: null };
    }
  }

  let buf;
  try {
    const fd = fs.openSync(entry.path, 'r');
    buf = Buffer.alloc(Math.min(PREVIEW_BYTES, Math.max(0, entry.size)));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
  } catch (e) {
    return { lines: [`(${e.code || 'unreadable'})`], lang: null };
  }
  if (buf.includes(0)) return { lines: [`binary file, ${humanBytes(entry.size)}`], lang: null };

  const lines = buf.toString('utf8').split('\n').slice(0, maxLines);
  return { lines, lang: detectLanguage(entry.name, lines[0] || '') };
}

// --- the screen -------------------------------------------------------------

const HELP = '↑↓ move  → open  ← up  / filter  . hidden  e edit  v view  q quit here  Q quit';

class FilesScreen {
  constructor(browser, { shell, io, output = process.stdout } = {}) {
    this.browser = browser;
    this.shell = shell;
    this.io = io;
    this.output = output;
    this.filtering = false;
    this.message = '';
    this.done = false;
    this.cdOnExit = false;
  }

  get rows() { return this.output.rows || 24; }

  get cols() { return this.output.columns || 80; }

  entryLabel(e, width) {
    const size = e.isDir ? '' : humanBytes(e.size);
    const name = e.name + (e.isDir ? '/' : e.isLink ? '@' : e.exec ? '*' : '');
    let color = '';
    if (e.broken) color = ansi.fg('red');
    else if (e.isDir) color = ansi.bold() + ansi.fg('blue');
    else if (e.isLink) color = ansi.fg('cyan');
    else if (e.exec) color = ansi.fg('green');
    else if (e.hidden) color = ansi.fg('gray');
    const nameWidth = Math.max(1, width - 7);
    return { color, text: `${fit(name, nameWidth)} ${size.padStart(5)} ` };
  }

  render() {
    const b = this.browser;
    const height = Math.max(1, this.rows - 2);
    const leftW = Math.max(20, Math.min(50, Math.floor(this.cols * 0.4)));
    const rightW = Math.max(0, this.cols - leftW - 1);
    b.scroll(height);

    const list = b.visible();
    const home = os.homedir();
    const where = b.cwd === home || b.cwd.startsWith(`${home}/`) ? `~${b.cwd.slice(home.length)}` : b.cwd;
    const filter = b.filter ? `   filter: ${b.filter}` : '';
    let s = '\x1b[H';
    s += bar(`  files  ${where}   ${list.length} item${list.length === 1 ? '' : 's'}${filter}`, this.cols);

    const preview = previewOf(b.current, height);
    const pstates = preview.lang ? computeStates(preview.lang, preview.lines) : null;

    for (let i = 0; i < height; i++) {
      s += '\r\n';
      const e = list[b.top + i];
      if (e) {
        const { color, text } = this.entryLabel(e, leftW);
        if (b.top + i === b.cursor) s += `${ansi.reverse()}${text}${ansi.reset()}`;
        else s += `${color}${text}${ansi.reset()}`;
      } else if (i === 0 && !list.length) {
        s += `${ansi.fg('gray')}${fit(b.filter ? '  (no matches)' : '  (empty)', leftW)}${ansi.reset()}`;
      } else {
        s += ' '.repeat(leftW);
      }

      s += `${ansi.fg('gray')}│${ansi.reset()}`;
      const pl = preview.lines[i];
      if (pl !== undefined && rightW > 1) {
        if (preview.lang) s += ` ${renderSlice(preview.lang, pl, pstates[i] || null, 0, rightW - 1)}`;
        else if (preview.dirListing) s += ` ${ansi.fg(pl.endsWith('/') ? 'blue' : 252)}${fit(pl, rightW - 1)}${ansi.reset()}`;
        else s += ` ${ansi.fg('gray')}${fit(pl, rightW - 1)}${ansi.reset()}`;
      }
      s += '\x1b[K';
    }

    s += '\r\n';
    if (this.filtering) s += `/${b.filter}\x1b[K`;
    else if (this.message || b.error) s += `${ansi.fg(214)}${this.message || b.error}${ansi.reset()}\x1b[K`;
    else s += `${ansi.fg('gray')}${HELP}${ansi.reset()}\x1b[K`;
    this.output.write(s);
  }

  // Opens a file in the editor or pager without leaving full-screen mode.
  open(entry, how) {
    if (how === 'view') {
      const { Pager, PagerScreen } = require('./view');
      let text;
      try { text = fs.readFileSync(entry.path, 'utf8'); } catch (e) { this.message = e.code; return; }
      new PagerScreen(new Pager(text, { name: entry.name }), { file: entry.path }).loop();
    } else {
      const { openEditor } = require('./pyedit');
      const res = openEditor(this.shell, this.io, entry.path);
      if (res.error) this.message = `cannot open ${entry.name}: ${res.error}`;
    }
    const keep = entry.name;
    this.browser.load(this.browser.cwd, keep);
    this.output.write('\x1b[2J');
  }

  handleKey(key) {
    const b = this.browser;
    if (key.name === 'eof') { this.done = true; return; }

    if (this.filtering) {
      if (key.name === 'return') { this.filtering = false; return; }
      if (key.name === 'escape') { this.filtering = false; b.setFilter(''); return; }
      if (key.name === 'backspace') { b.setFilter(b.filter.slice(0, -1)); return; }
      if (key.name === 'up' || key.name === 'down') { b.move(key.name === 'up' ? -1 : 1); return; }
      if (key.printable) b.setFilter(b.filter + key.str);
      return;
    }

    this.message = '';
    const height = Math.max(1, this.rows - 2);
    if (key.ctrl && key.name === 'c') { this.done = true; return; }

    switch (key.name) {
      case 'q': this.done = true; this.cdOnExit = true; break;
      case 'Q': case 'escape': this.done = true; break;
      case 'up': case 'k': b.move(-1); break;
      case 'down': case 'j': b.move(1); break;
      case 'pageup': b.move(-height); break;
      case 'pagedown': case ' ': case 'space': b.move(height); break;
      case 'g': case 'home': b.moveTo(0); break;
      case 'G': case 'end': b.moveTo(Number.MAX_SAFE_INTEGER); break;
      case 'left': case 'h': case 'backspace': b.up(); break;
      case 'right': case 'l': case 'return': {
        const r = b.enter();
        if (r && r.action === 'open') this.open(r.entry, key.name === 'return' ? 'edit' : 'view');
        break;
      }
      case 'e': if (b.current && !b.current.isDir) this.open(b.current, 'edit'); break;
      case 'v': if (b.current && !b.current.isDir) this.open(b.current, 'view'); break;
      case '.': b.toggleHidden(); this.message = b.showHidden ? 'showing hidden files' : 'hiding hidden files'; break;
      case '/': this.filtering = true; break;
      case '~': b.load(os.homedir()); break;
      case 'r': b.load(b.cwd, b.current && b.current.name); this.message = 'refreshed'; break;
      default: break;
    }
  }

  loop() {
    const reader = new KeyReader(0);
    this.render();
    while (!this.done) {
      this.handleKey(reader.next());
      if (!this.done) this.render();
    }
    return 0;
  }
}

// The `files` builtin. `q` leaves the shell in the directory being viewed.
function runFiles(args, io, shell) {
  const target = args.find((a) => !a.startsWith('-'));
  const dir = shell.resolve(target || '.');
  let st;
  try { st = fs.statSync(dir); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    shell.writeTo(io.stderr, `files: not a directory: ${target}\n`);
    return 1;
  }
  if (!requireTty('files', io, shell)) return 1;

  const browser = new FileBrowser(fs.realpathSync(dir), { showHidden: args.includes('-a') });
  const screen = new FilesScreen(browser, { shell, io });
  fullscreen(() => screen.loop(), { cursor: false });

  if (screen.cdOnExit && browser.cwd !== shell.cwd) {
    try { shell.setCwd(browser.cwd); } catch { /* directory vanished */ }
  }
  return 0;
}

module.exports = { FileBrowser, FilesScreen, previewOf, runFiles };
