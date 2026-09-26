'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const ops = require('./fileops');
const { KeyReader } = require('./keys');
const { detectLanguage, computeStates, renderSlice } = require('./syntax');
const { fullscreen, requireTty, fit, humanBytes, textWidth, MOUSE_ON, MOUSE_OFF } = require('./tui');

const PREVIEW_BYTES = 64 * 1024;
const POLL_MS = 1000;
const DOUBLE_CLICK_MS = 500;
const ICONS = process.env.MAXSHELL_ICONS !== '0' && process.env.TERM !== 'linux';

// --- kinds and icons, the way Finder names things ------------------------------

const KIND_BY_EXT = {
  '.py': ['Python source', '🐍'], '.pyw': ['Python source', '🐍'],
  '.js': ['JavaScript', '🟨'], '.mjs': ['JavaScript', '🟨'], '.cjs': ['JavaScript', '🟨'], '.jsx': ['JavaScript', '🟨'],
  '.ts': ['TypeScript', '🟦'], '.tsx': ['TypeScript', '🟦'],
  '.c': ['C source', '🔩'], '.cpp': ['C++ source', '🔩'], '.cc': ['C++ source', '🔩'], '.cxx': ['C++ source', '🔩'],
  '.h': ['C header', '🔩'], '.hpp': ['C++ header', '🔩'], '.ino': ['Arduino sketch', '🔩'],
  '.sh': ['Shell script', '🐚'], '.zsh': ['Shell script', '🐚'], '.bash': ['Shell script', '🐚'], '.mxsh': ['maxshell script', '🐚'],
  '.json': ['JSON', '🔧'], '.yaml': ['YAML', '🔧'], '.yml': ['YAML', '🔧'], '.toml': ['TOML', '🔧'],
  '.ini': ['Config file', '🔧'], '.conf': ['Config file', '🔧'], '.xml': ['XML', '🔧'], '.plist': ['Property list', '🔧'],
  '.md': ['Markdown', '📝'], '.markdown': ['Markdown', '📝'], '.txt': ['Plain text', '📝'], '.rtf': ['Rich text', '📝'],
  '.csv': ['CSV text', '📝'], '.log': ['Log file', '📝'],
  '.html': ['HTML', '🌐'], '.htm': ['HTML', '🌐'], '.css': ['CSS', '🌐'],
  '.png': ['PNG image', '🎨'], '.jpg': ['JPEG image', '🎨'], '.jpeg': ['JPEG image', '🎨'], '.gif': ['GIF image', '🎨'],
  '.heic': ['HEIC image', '🎨'], '.webp': ['WebP image', '🎨'], '.svg': ['SVG image', '🎨'], '.bmp': ['BMP image', '🎨'],
  '.tiff': ['TIFF image', '🎨'], '.ico': ['Icon', '🎨'],
  '.mp3': ['MP3 audio', '🎵'], '.wav': ['WAV audio', '🎵'], '.m4a': ['AAC audio', '🎵'], '.flac': ['FLAC audio', '🎵'], '.aac': ['AAC audio', '🎵'],
  '.mp4': ['MPEG-4 movie', '🎬'], '.mov': ['QuickTime movie', '🎬'], '.mkv': ['Matroska video', '🎬'], '.avi': ['AVI video', '🎬'], '.webm': ['WebM video', '🎬'],
  '.zip': ['ZIP archive', '📦'], '.tar': ['Tar archive', '📦'], '.gz': ['Gzip archive', '📦'], '.tgz': ['Gzip archive', '📦'],
  '.bz2': ['Bzip2 archive', '📦'], '.xz': ['XZ archive', '📦'], '.7z': ['7-Zip archive', '📦'], '.rar': ['RAR archive', '📦'],
  '.dmg': ['Disk image', '💿'], '.iso': ['Disk image', '💿'], '.pkg': ['Installer package', '📦'],
  '.pdf': ['PDF document', '📕'], '.paprikarecipes': ['Paprika recipes', '📕'],
};

function describe(e) {
  if (e.broken) return { kind: 'Broken alias', icon: '🔗' };
  if (e.isDir) {
    if (e.name.endsWith('.app')) return { kind: 'Application', icon: '🚀' };
    return { kind: e.isLink ? 'Alias to folder' : 'Folder', icon: '📁' };
  }
  const ext = path.extname(e.name).toLowerCase();
  if (KIND_BY_EXT[ext]) return { kind: KIND_BY_EXT[ext][0], icon: KIND_BY_EXT[ext][1] };
  if (e.isLink) return { kind: 'Alias', icon: '🔗' };
  if (e.exec) return { kind: 'Unix executable', icon: '🚀' };
  if (ext) return { kind: `${ext.slice(1).toUpperCase()} file`, icon: '📄' };
  return { kind: 'Document', icon: '📄' };
}

function iconOf(e) {
  if (ICONS) return describe(e).icon;
  return e.isDir ? '▸' : ' ';
}

function sniffText(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

// Whether Enter should open this in the terminal editor rather than an app.
function isTextual(e) {
  if (!e || e.isDir || e.broken) return false;
  const { kind } = describe(e);
  if (/image|audio|movie|video|archive|PDF|Disk image|Application|executable|package|recipes/i.test(kind)) return false;
  if (/source|script|JSON|YAML|TOML|Markdown|text|HTML|CSS|Config|XML|header|Log|list|sketch/i.test(kind)) return true;
  return sniffText(e.path);
}

// "Today at 09:12", "Yesterday at 20:36", "Aug 13, 2026 at 12:29"
function finderDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const time = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${time}`;
}

// --- reading folders ----------------------------------------------------------

function readEntries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
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
      birthtime: st ? st.birthtimeMs : 0,
      exec: !!st && st.isFile() && (st.mode & 0o111) !== 0,
      hidden: d.name.startsWith('.'),
      broken: !st,
    };
  });
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
const SORTS = {
  name: byName,
  date: (a, b) => b.mtime - a.mtime || byName(a, b),
  size: (a, b) => b.size - a.size || byName(a, b),
  kind: (a, b) => describe(a).kind.localeCompare(describe(b).kind) || byName(a, b),
};
const SORT_ORDER = ['name', 'date', 'size', 'kind'];

// Folders stay on top, as with Finder's "Keep folders on top".
function sortEntries(list, key = 'name') {
  const cmp = SORTS[key] || SORTS.name;
  return list.slice().sort((a, b) => (a.isDir === b.isDir ? cmp(a, b) : a.isDir ? -1 : 1));
}

function dirSig(dir) {
  try { return String(fs.statSync(dir).mtimeMs); } catch { return null; }
}

// --- the model ------------------------------------------------------------------

class FileBrowser {
  constructor(dir, { showHidden = false } = {}) {
    this.showHidden = showHidden;
    this.sortKey = 'name';
    this.filter = '';
    this.cursor = 0;
    this.top = 0;
    this.error = '';
    this.marked = new Set();
    this.backStack = [];
    this.forwardStack = [];
    this.all = [];
    this.load(dir);
  }

  load(dir, focusName = null) {
    let entries;
    try {
      entries = readEntries(dir);
    } catch (e) {
      this.error = `cannot open ${dir}: ${e.code || e.message}`;
      return false;
    }
    if (dir !== this.cwd) this.marked.clear();
    this.cwd = dir;
    this.sig = dirSig(dir);
    this.error = '';
    this.filter = '';
    this.all = sortEntries(entries, this.sortKey);
    this.focus(focusName);
    this.top = 0;
    return true;
  }

  // Navigates, recording history for back and forward.
  goTo(dir, focusName = null) {
    const from = this.cwd;
    if (!this.load(dir, focusName)) return false;
    if (from && from !== dir) {
      this.backStack.push(from);
      this.forwardStack = [];
    }
    return true;
  }

  back() {
    const dir = this.backStack.pop();
    if (!dir) return false;
    const from = this.cwd;
    if (!this.load(dir, path.basename(from))) return false;
    this.forwardStack.push(from);
    return true;
  }

  forward() {
    const dir = this.forwardStack.pop();
    if (!dir) return false;
    const from = this.cwd;
    if (!this.load(dir)) return false;
    this.backStack.push(from);
    return true;
  }

  // Re-reads the folder, keeping the cursor, filter and marks where they were.
  reload(focusName) {
    const keep = focusName !== undefined ? focusName : (this.current && this.current.name);
    const { filter, marked } = this;
    let entries;
    try { entries = readEntries(this.cwd); } catch (e) { this.error = e.code || e.message; return false; }
    this.all = sortEntries(entries, this.sortKey);
    this.sig = dirSig(this.cwd);
    this.filter = filter;
    this.marked = new Set([...marked].filter((p) => entries.some((e) => e.path === p)));
    this.focus(keep);
    return true;
  }

  changedOnDisk() { return dirSig(this.cwd) !== this.sig; }

  focus(name) {
    const at = name ? this.visible().findIndex((e) => e.name === name) : -1;
    this.cursor = at === -1 ? Math.min(this.cursor, Math.max(0, this.visible().length - 1)) : at;
    if (at === -1 && name === null) this.cursor = 0;
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
    const at = keep ? this.visible().findIndex((e) => e.name === keep) : -1;
    this.cursor = at === -1 ? 0 : at;
  }

  toggleHidden() {
    const keep = this.current && this.current.name;
    this.showHidden = !this.showHidden;
    const at = keep ? this.visible().findIndex((e) => e.name === keep) : -1;
    this.cursor = at === -1 ? 0 : at;
  }

  sortBy(key) {
    if (!SORTS[key]) return;
    const keep = this.current && this.current.name;
    this.sortKey = key;
    this.all = sortEntries(this.all, key);
    this.focus(keep);
  }

  cycleSort() {
    this.sortBy(SORT_ORDER[(SORT_ORDER.indexOf(this.sortKey) + 1) % SORT_ORDER.length]);
    return this.sortKey;
  }

  toggleMark() {
    const e = this.current;
    if (!e) return;
    if (this.marked.has(e.path)) this.marked.delete(e.path);
    else this.marked.add(e.path);
  }

  markAll() { for (const e of this.visible()) this.marked.add(e.path); }

  clearMarks() { this.marked.clear(); }

  // What an operation acts on: the marked items, or else the one under the cursor.
  targets() {
    const marked = this.visible().filter((e) => this.marked.has(e.path));
    if (marked.length) return marked;
    return this.current ? [this.current] : [];
  }

  enter() {
    const e = this.current;
    if (!e) return null;
    if (e.isDir) {
      this.goTo(e.path);
      return { action: 'cd' };
    }
    return { action: 'open', entry: e };
  }

  up() {
    const parent = path.dirname(this.cwd);
    if (parent === this.cwd) return false;
    return this.goTo(parent, path.basename(this.cwd));
  }

  scroll(height) {
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + height) this.top = this.cursor - height + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.visible().length - height)));
  }
}

// What the preview column shows below the item's summary.
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
      return { lines: names.slice(0, maxLines), lang: null, dirListing: true, total: names.length };
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

// --- icon view: big icons with names underneath ---------------------------------

const ART_W = 12;
const ART_H = 5;
const LABEL_LINES = 2;
const CELL_H = ART_H + LABEL_LINES + 1;
const MIN_CELL_W = 20;

// Glyphs Finder draws on special folders.
const FOLDER_BADGES = {
  Desktop: '💻', Documents: '📚', Downloads: '📥', Movies: '🎬', Music: '🎵',
  Pictures: '🎨', Public: '👥', Applications: '🧰', Library: '📖', Sites: '🌐',
};

const bg = (n) => ansi.sgr(`48;5;${n}`);
const barStyle = () => { const { ui } = theme.current(); return `${bg(ui.bar.bg)}${ansi.fg(ui.bar.fg)}`; };
const selStyle = () => { const { ui } = theme.current(); return `${bg(ui.select.bg)}${ansi.fg(ui.select.fg)}`; };

// Icons are drawn as 12×10 pixel bitmaps. Each terminal row shows two pixel
// rows using half blocks (fg = upper pixel, bg = lower), so a 12×5 cell area
// gets enough detail for a tab, layered panels and rounded corners.
// '.' is transparent; other letters map to 256-colour palette entries.
const FOLDER = [
  '.tttt.......',
  'tttttttttttt',
  'hhhhhhhhhhhh',
  'ffffffffffff',
  'ffffffffffff',
  'ffffffffffff',
  'ffffffffffff',
  'ffffffffffff',
  'bbbbbbbbbbbb',
  '.ssssssssss.',
];
// Back panel and tab, a highlight along the front's top edge, the front,
// then a darker band and a rounded shadow — lighter at the top, like macOS.

const PAGE = [
  '.ppppppppd..',
  '.ppppppppdd.',
  '.pppppppppp.',
  '.pplllllllp.',
  '.pppppppppp.',
  '.pplllllppp.',
  '.pppppppppp.',
  '.pppppppppp.',
  '.pppppppppp.',
  '.ssssssssss.',
];

const APP = [
  '............',
  '..aaaaaaaa..',
  '.aaaaaaaaaa.',
  '.aaaaaaaaaa.',
  '.aaaaaaaaaa.',
  '.aaaaaaaaaa.',
  '.aaaaaaaaaa.',
  '.aaaaaaaaaa.',
  '..aaaaaaaa..',
  '...ssssss...',
];

// Renders a bitmap to ART_H rows. `badge` is an emoji placed on the fourth
// row (pixel rows 6–7), which the caller keeps a solid colour behind.
function drawBitmap(bitmap, colors, { base = null, badge = null } = {}) {
  const baseBg = base === null ? '' : bg(base);
  const R = ansi.reset() + baseBg;
  const rows = [];
  for (let r = 0; r < ART_H; r++) {
    let line = baseBg;
    for (let x = 0; x < ART_W; x++) {
      if (badge && r === 3 && (x === 5 || x === 6)) {
        if (x === 5) line += `${bg(colors[bitmap[6][5]])}${badge}${R}`;
        continue;
      }
      const top = bitmap[2 * r][x];
      const bottom = bitmap[2 * r + 1][x];
      const ct = top === '.' ? null : colors[top];
      const cb = bottom === '.' ? null : colors[bottom];
      if (ct === null && cb === null) line += ' ';
      else if (ct === cb) line += `${bg(ct)} ${R}`;
      else if (ct === null) line += `${ansi.fg(cb)}▄${R}`;
      else if (cb === null) line += `${ansi.fg(ct)}▀${R}`;
      else line += `${ansi.fg(ct)}${bg(cb)}▀${R}`;
    }
    rows.push(line + ansi.reset());
  }
  return rows;
}

// Tints for pages, by kind; most documents are plain white like Finder's.
function pageColors(kind) {
  const paper = /image/i.test(kind) ? 195 : /archive|package|Disk/i.test(kind) ? 223 : 255;
  return { p: paper, d: 250, l: 250, s: 245 };
}

// Four-and-a-bit rows of block-character art, each exactly ART_W wide.
// `base` is a background colour number re-applied after every reset so the
// selection tile shows through transparent pixels.
function iconArt(e, base = null) {
  if (!ICONS || !ansi.isEnabled()) {
    const plain = e.isDir
      ? [' ____       ', '|    \\_____ ', '|          |', '|          |', '|__________|']
      : ['  _______   ', ' |       \\  ', ' |  ~~~~  | ', ' |  ~~~   | ', ' |________| '];
    const b = base === null ? '' : bg(base);
    return plain.map((l) => b + l + ansi.reset());
  }
  if (e.isDir && e.name.endsWith('.app')) {
    return drawBitmap(APP, { a: 25, s: 238 }, { base, badge: '🚀' });
  }
  if (e.isDir) {
    return drawBitmap(FOLDER, theme.current().ui.folder, { base, badge: FOLDER_BADGES[e.name] || null });
  }
  const { icon, kind } = describe(e);
  return drawBitmap(PAGE, pageColors(kind), { base, badge: icon });
}

// Splits text to fit `width` columns, keeping the end (usually the
// extension) and cutting the middle: "2025-05-05 at 12.35.43.png" becomes
// "2025-0…5.43.png".
function middleTruncate(text, width) {
  if (textWidth(text) <= width) return text;
  const chars = [...text];
  const keepEnd = Math.floor((width - 1) / 2);
  const keepStart = width - 1 - keepEnd;
  return `${chars.slice(0, keepStart).join('')}…${chars.slice(chars.length - keepEnd).join('')}`;
}

// Finder's two-line icon label: break at the last space that fits (or a
// dash or underscore if there is no space), otherwise break hard, then
// shorten the second line in the middle so its end — the extension — shows.
function finderLabel(name, width) {
  if (textWidth(name) <= width) return { lines: [name], truncated: false };
  const chars = [...name];
  let spaceCut = -1;
  let otherCut = -1;
  let fits = 0;
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    w += textWidth(chars[i]);
    if (w > width) break;
    fits = i + 1;
    if (chars[i] === ' ') spaceCut = i + 1;
    else if (chars[i] === '-' || chars[i] === '_') otherCut = i + 1;
  }
  const cut = spaceCut > 0 ? spaceCut : otherCut > 0 ? otherCut : fits;
  const first = chars.slice(0, cut).join('').trimEnd();
  const rest = chars.slice(cut).join('').trimStart();
  const second = middleTruncate(rest, width);
  return { lines: [first, second], truncated: second !== rest };
}

function center(text, width) {
  const w = textWidth(text);
  const left = Math.max(0, Math.floor((width - w) / 2));
  return { left, right: Math.max(0, width - w - left) };
}

// --- the sidebar ----------------------------------------------------------------

function sidebarItems() {
  const home = os.homedir();
  const fav = [
    ['🏠', path.basename(home), home],
    ['💻', 'Desktop', path.join(home, 'Desktop')],
    ['📚', 'Documents', path.join(home, 'Documents')],
    ['📥', 'Downloads', path.join(home, 'Downloads')],
    ['🧰', 'Applications', '/Applications'],
    ['💭', 'iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')],
  ].filter(([, , p]) => fs.existsSync(p));
  const places = [['💿', 'Macintosh HD', '/']];
  try {
    for (const v of fs.readdirSync('/Volumes')) {
      const p = path.join('/Volumes', v);
      if (fs.realpathSync(p) !== '/') places.push(['💿', v, p]);
    }
  } catch { /* no /Volumes */ }
  return [
    { header: 'Favorites' },
    ...fav.map(([icon, label, p]) => ({ icon, label, path: p })),
    { header: 'Locations' },
    ...places.map(([icon, label, p]) => ({ icon, label, path: p })),
  ];
}

// --- the screen -----------------------------------------------------------------

const HELP_LINES = `
 files — a Finder-style browser for the terminal

 Views
   V                 switch between icon view (the default) and column view

 Getting around
   arrows            select (in icon view they move around the grid; in
                     column view → opens a folder and ← goes up)
   Enter             open                   Backspace     enclosing folder
   [  ]              back / forward
   Tab               focus the sidebar      1–9           jump to a favorite
   g  G              first / last item      ~             home folder

 Opening
   Enter             folders open; text and code open in edit, anything
                     else opens in its default Mac app
   Space             Quick Look (text in a pager, anything else in the
                     macOS Quick Look window)
   o                 open with the default app      e / v    edit / view

 Organising                                   everything here is undoable
   n  N              new folder / new file      r        rename
   d                 duplicate                  c x p    copy / cut / paste
   t  Delete         move to Trash              u  ^Z    undo
   m                 mark (select several)      a  A     mark all / none

 Viewing
   s                 sort: name, date, size, kind
   i                 Get Info                   .        show hidden files
   /                 filter this folder         f        search subfolders
   b                 show or hide the sidebar   ?        this help

 Mouse
   click             select            double-click    open, like Finder
   wheel             scroll            sidebar / path bar     click to go there
   (start with  files --no-mouse  to leave the mouse to the terminal)

 Leaving
   q                 quit, leaving the shell in this folder
   Q  ^C             quit without moving
`.split('\n');

class FilesScreen {
  constructor(browser, { shell, io, output = process.stdout } = {}) {
    this.browser = browser;
    this.shell = shell;
    this.io = io;
    this.output = output;
    this.mode = 'browse';
    this.view = process.env.MAXSHELL_FILES_VIEW === 'columns' ? 'columns' : 'icons';
    this.gridTop = 0;
    this.focus = 'files';
    this.showSidebar = true;
    this.sidebar = sidebarItems();
    this.sideIndex = this.sidebar.findIndex((s) => s.path);
    this.clipboard = null;
    this.undoStack = [];
    this.prompt = null;
    this.filtering = false;
    this.search = null;
    this.info = null;
    this.helpTop = 0;
    this.message = '';
    this.done = false;
    this.cdOnExit = false;
    this.parentCache = new Map();
    this.mouse = false;
    this.lastClick = null;
    this.pathSegs = [];
    this.parentTop = 0;
  }

  get rows() { return this.output.rows || 24; }

  get cols() { return this.output.columns || 80; }

  // --- layout ---------------------------------------------------------------

  layout() {
    const W = this.cols;
    const sideW = this.showSidebar && W >= 80 ? 20 : 0;
    const rest = W - sideW - (sideW ? 1 : 0);
    const previewW = rest >= 60 ? Math.floor(rest * 0.36) : 0;
    const parentW = rest >= 100 ? Math.floor(rest * 0.22) : 0;
    const currentW = rest - previewW - parentW - (previewW ? 1 : 0) - (parentW ? 1 : 0);
    const bodyH = Math.max(3, this.rows - 3);
    if (this.view === 'icons') {
      const perRow = Math.max(1, Math.floor(rest / MIN_CELL_W));
      const cellW = Math.floor(rest / perRow);
      return {
        sideW, parentW: 0, currentW: rest, previewW: 0, bodyH,
        perRow, cellW, rowsVisible: Math.max(1, Math.floor(bodyH / CELL_H)),
      };
    }
    return { sideW, parentW, currentW, previewW, bodyH };
  }

  // The grid, CELL_H lines per row of icons, exactly `L.currentW` wide.
  iconGrid(L) {
    const b = this.browser;
    const list = b.visible();
    const { perRow, cellW, rowsVisible } = L;
    const cursorRow = Math.floor(b.cursor / perRow);
    if (cursorRow < this.gridTop) this.gridTop = cursorRow;
    if (cursorRow >= this.gridTop + rowsVisible) this.gridTop = cursorRow - rowsVisible + 1;
    const totalRows = Math.ceil(list.length / perRow);
    this.gridTop = Math.max(0, Math.min(this.gridTop, Math.max(0, totalRows - rowsVisible)));

    const lines = [];
    const spare = ' '.repeat(L.currentW - perRow * cellW);
    this.tooltip = null;
    for (let r = 0; r < rowsVisible; r++) {
      const rowLines = Array.from({ length: CELL_H }, () => '');
      for (let c = 0; c < perRow; c++) {
        const i = (this.gridTop + r) * perRow + c;
        const e = list[i];
        if (!e) { for (let k = 0; k < CELL_H; k++) rowLines[k] += ' '.repeat(cellW); continue; }
        const selected = i === b.cursor && this.focus === 'files';
        const marked = b.marked.has(e.path);
        const pad = Math.floor((cellW - ART_W) / 2);

        const art = iconArt(e, selected ? theme.current().ui.selectDim : null);
        for (let k = 0; k < ART_H; k++) {
          const edge = selected ? `${bg(theme.current().ui.selectDim)} ${ansi.reset()}` : ' ';
          rowLines[k] += `${' '.repeat(pad - 1)}${edge}${art[k]}${edge}${' '.repeat(cellW - pad - ART_W - 1)}`;
        }

        const label = finderLabel(e.name, cellW - 2);
        for (let k = 0; k < LABEL_LINES; k++) {
          const text = label.lines[k] || '';
          const { left, right } = center(text, cellW);
          let painted = text;
          if (text && (selected || marked)) {
            const { ui } = theme.current();
            painted = `${bg(selected ? ui.select.bg : ui.marked)}${ansi.fg(ui.select.fg)}${text}${ansi.reset()}`;
          }
          else if (text && e.hidden) painted = `${ansi.fg('gray')}${text}${ansi.reset()}`;
          rowLines[ART_H + k] += `${' '.repeat(left)}${painted}${' '.repeat(right)}`;
        }
        rowLines[CELL_H - 1] += ' '.repeat(cellW);

        if (selected && label.truncated) {
          this.tooltip = { text: e.name, row: r, col: c * cellW + pad - 1 };
        }
      }
      for (const l of rowLines) lines.push(l + spare);
    }
    while (lines.length < L.bodyH) {
      lines.push(!list.length && lines.length === 1
        ? `${ansi.fg('gray')}${fit(b.filter ? '  no matches' : '  folder is empty', L.currentW)}${ansi.reset()}`
        : ' '.repeat(L.currentW));
    }
    return lines.slice(0, L.bodyH);
  }

  // Finder shows a truncated name in full in a tooltip; draw it over the
  // blank line above the icon (or below the label on the first row).
  renderTooltip(L) {
    const t = this.tooltip;
    if (!t) return;
    const text = ` ${t.text} `;
    const maxW = L.currentW - 2;
    const shown = textWidth(text) > maxW ? fit(text, maxW) : text;
    const originX = (L.sideW ? L.sideW + 1 : 0) + 1;
    let x = originX + t.col;
    x = Math.min(x, originX + L.currentW - textWidth(shown));
    const top = 2 + t.row * CELL_H;
    const y = t.row === 0 ? top + CELL_H - 1 : top - 1;
    this.output.write(`\x1b[${y};${Math.max(originX, x)}H${bg(236)}${ansi.fg(252)}${shown}${ansi.reset()}`);
  }

  parentEntries() {
    const parent = path.dirname(this.browser.cwd);
    if (parent === this.browser.cwd) return null;
    const sig = dirSig(parent);
    const hit = this.parentCache.get(parent);
    if (hit && hit.sig === sig && hit.hidden === this.browser.showHidden && hit.sort === this.browser.sortKey) return hit.list;
    let list = [];
    try { list = sortEntries(readEntries(parent), this.browser.sortKey); } catch { /* unreadable */ }
    list = list.filter((e) => this.browser.showHidden || !e.hidden);
    this.parentCache.set(parent, { sig, hidden: this.browser.showHidden, sort: this.browser.sortKey, list });
    return list;
  }

  // One row of a file column, exactly `w` columns wide.
  row(e, w, { selected, active, marked }) {
    const mark = marked ? `${ansi.fg('cyan')}•${ansi.reset()}` : ' ';
    const chevron = e.isDir ? '›' : ' ';
    const label = fit(`${iconOf(e)} ${e.name}`, Math.max(1, w - 3));
    const text = `${label} ${chevron}`;
    const { ui } = theme.current();
    if (selected && active) return `${mark}${bg(ui.select.bg)}${ansi.fg(ui.select.fg)}${text}${ansi.reset()}`;
    if (selected) return `${mark}${bg(ui.selectDim)}${text}${ansi.reset()}`;
    let color = '';
    if (e.broken) color = ansi.fg('red');
    else if (e.isDir) color = ansi.fg(theme.current().ui.dir);
    else if (e.hidden) color = ansi.fg('gray');
    return `${mark}${color}${text}${ansi.reset()}`;
  }

  column(list, cursor, top, w, h, opts = {}) {
    const lines = [];
    for (let i = 0; i < h; i++) {
      const e = list[top + i];
      if (!e) {
        const blank = i === 0 && !list.length ? fit(opts.empty || '', w) : ' '.repeat(w);
        lines.push(`${ansi.fg('gray')}${blank}${ansi.reset()}`);
        continue;
      }
      lines.push(this.row(e, w, {
        selected: top + i === cursor,
        active: opts.active,
        marked: opts.marked && opts.marked.has(e.path),
      }));
    }
    return lines;
  }

  sidebarColumn(w, h) {
    const lines = [];
    const cwd = this.browser.cwd;
    for (let i = 0; i < h; i++) {
      const s = this.sidebar[i];
      if (!s) { lines.push(' '.repeat(w)); continue; }
      if (s.header) { lines.push(`${ansi.fg('gray')}${fit(` ${s.header}`, w)}${ansi.reset()}`); continue; }
      const text = fit(`  ${ICONS ? s.icon : '•'} ${s.label}`, w);
      if (this.focus === 'sidebar' && i === this.sideIndex) lines.push(`${selStyle()}${text}${ansi.reset()}`);
      else if (s.path === cwd) lines.push(`${ansi.bold()}${ansi.fg(theme.current().ui.dir)}${text}${ansi.reset()}`);
      else lines.push(text);
    }
    return lines;
  }

  previewColumn(entry, w, h) {
    const lines = [];
    const pad = (s) => fit(s, w);
    if (!entry || w < 8) {
      for (let i = 0; i < h; i++) lines.push(' '.repeat(w));
      return lines;
    }
    const { kind } = describe(entry);
    const inner = w - 2;
    lines.push(` ${ansi.bold()}${fit(`${ICONS ? `${describe(entry).icon} ` : ''}${entry.name}`, inner)}${ansi.reset()} `);
    const pv = previewOf(entry, Math.max(0, h - 5));
    const sizeText = entry.isDir ? `${pv.total ?? 0} item${pv.total === 1 ? '' : 's'}` : humanBytes(entry.size);
    lines.push(`${ansi.fg('gray')} ${fit(`${kind} · ${sizeText}`, inner)} ${ansi.reset()}`);
    lines.push(`${ansi.fg('gray')} ${fit(`Modified ${finderDate(entry.mtime)}`, inner)} ${ansi.reset()}`);
    lines.push(`${ansi.fg(238)}${'─'.repeat(w)}${ansi.reset()}`);

    const body = h - lines.length;
    if (pv.lang) {
      const states = computeStates(pv.lang, pv.lines);
      for (let i = 0; i < body; i++) {
        const l = pv.lines[i];
        if (l === undefined) { lines.push(' '.repeat(w)); continue; }
        const painted = renderSlice(pv.lang, l.replace(/\t/g, '    '), states[i] || null, 0, inner);
        lines.push(` ${painted}${' '.repeat(Math.max(0, inner - textWidth(l.replace(/\t/g, '    ').slice(0, inner))))} `);
      }
    } else {
      for (let i = 0; i < body; i++) {
        const l = pv.lines[i];
        if (l === undefined) { lines.push(' '.repeat(w)); continue; }
        if (pv.dirListing) {
          const isDir = l.endsWith('/');
          const name = isDir ? l.slice(0, -1) : l;
          const icon = ICONS ? `${describe({ name, isDir, path: '' }).icon} ` : '';
          lines.push(` ${isDir ? ansi.fg(theme.current().ui.dir) : ansi.fg(252)}${fit(`${icon}${name}`, inner)}${ansi.reset()} `);
        } else {
          lines.push(` ${ansi.fg('gray')}${fit(l, inner)}${ansi.reset()} `);
        }
      }
    }
    return lines.slice(0, h);
  }

  pathBar() {
    const home = os.homedir();
    const cwd = this.search ? path.dirname(this.searchCurrent() || this.browser.cwd) : this.browser.cwd;
    const segs = [];
    let rest;
    if (cwd === home || cwd.startsWith(`${home}/`)) {
      segs.push({ label: `${ICONS ? '🏠 ' : ''}${path.basename(home)}`, path: home });
      rest = cwd.slice(home.length);
    } else {
      segs.push({ label: `${ICONS ? '💿 ' : ''}Macintosh HD`, path: '/' });
      rest = cwd;
    }
    let acc = segs[0].path;
    for (const part of rest.split('/').filter(Boolean)) {
      acc = path.join(acc, part);
      segs.push({ label: part, path: acc });
    }
    // Screen columns (1-based) of each segment, for clicks.
    let x = 2;
    this.pathSegs = segs.map((seg, i) => {
      const w = textWidth(seg.label);
      const hit = { from: x, to: x + w - 1, path: seg.path };
      x += w + (i < segs.length - 1 ? 3 : 0);
      return hit;
    });
    return `${ansi.fg('gray')}${fit(` ${segs.map((seg) => seg.label).join(' › ')}`, this.cols)}${ansi.reset()}`;
  }

  statusBar() {
    if (this.prompt) {
      const p = this.prompt;
      return `${ansi.fg(214)} ${p.label}${ansi.reset()}${p.value}\x1b[K`;
    }
    if (this.filtering) return ` /${this.browser.filter}\x1b[K`;
    const b = this.browser;
    const count = b.visible().length;
    const marked = b.visible().filter((e) => b.marked.has(e.path)).length;
    let free = '';
    try {
      const st = fs.statfsSync(b.cwd);
      free = `, ${humanBytes(st.bavail * st.bsize)} available`;
    } catch { /* statfs unavailable */ }
    const left = marked
      ? ` ${marked} of ${count} selected${free}`
      : ` ${count} item${count === 1 ? '' : 's'}${free}`;
    const clip = this.clipboard ? `   ${this.clipboard.mode === 'cut' ? '✂' : '⧉'} ${this.clipboard.paths.length} on clipboard` : '';
    const right = this.message ? `${this.message} ` : '? keys  q quit ';
    const room = this.cols - textWidth(left + clip) - textWidth(right);
    const rightColor = this.message ? ansi.fg(214) : ansi.fg('gray');
    return `${ansi.fg('gray')}${left}${clip}${ansi.reset()}${' '.repeat(Math.max(1, room))}${rightColor}${right}${ansi.reset()}`;
  }

  titleBar() {
    const b = this.browser;
    const dim = (ch) => `${ansi.fg(theme.current().ui.muted)}${ch}${ansi.reset()}${barStyle()}`;
    const nav = `${b.backStack.length ? '‹' : dim('‹')} ${b.forwardStack.length ? '›' : dim('›')}`;
    const name = this.search ? `Searching “${this.search.query}”` : (path.basename(b.cwd) || 'Macintosh HD');
    const right = `sorted by ${b.sortKey} `;
    const mid = Math.max(0, Math.floor((this.cols - textWidth(name)) / 2) - 6);
    const line = `  ${nav}${' '.repeat(mid)}${name}`;
    const used = textWidth(ansi.strip(line));
    return `${barStyle()}${line}${' '.repeat(Math.max(1, this.cols - used - right.length))}${right}${ansi.reset()}`;
  }

  // --- search results --------------------------------------------------------

  searchCurrent() {
    return this.search && this.search.results[this.search.cursor];
  }

  searchColumn(w, h) {
    const s = this.search;
    if (s.cursor < s.top) s.top = s.cursor;
    if (s.cursor >= s.top + h) s.top = s.cursor - h + 1;
    const lines = [];
    for (let i = 0; i < h; i++) {
      const p = s.results[s.top + i];
      if (!p) {
        lines.push(i === 0 && !s.results.length ? `${ansi.fg('gray')}${fit('  no matches', w)}${ansi.reset()}` : ' '.repeat(w));
        continue;
      }
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch { /* gone */ }
      const rel = path.relative(this.browser.cwd, p);
      const text = fit(` ${ICONS ? `${describe({ name: path.basename(p), isDir, path: p }).icon} ` : ''}${rel}`, w);
      lines.push(s.top + i === s.cursor ? `${selStyle()}${text}${ansi.reset()}` : `${isDir ? ansi.fg(theme.current().ui.dir) : ''}${text}${ansi.reset()}`);
    }
    return lines;
  }

  searchEntry() {
    const p = this.searchCurrent();
    if (!p) return null;
    try {
      return readEntries(path.dirname(p)).find((e) => e.path === p) || null;
    } catch {
      return null;
    }
  }

  // --- drawing ---------------------------------------------------------------

  render() {
    if (this.mode === 'help') return this.renderHelp();
    const b = this.browser;
    const L = this.layout();
    const sep = `${ansi.fg(238)}│${ansi.reset()}`;

    let current;
    let preview;
    if (this.search) {
      current = this.searchColumn(L.currentW, L.bodyH);
      preview = L.previewW ? this.previewColumn(this.searchEntry(), L.previewW, L.bodyH) : null;
    } else if (this.view === 'icons') {
      current = this.iconGrid(L);
    } else {
      b.scroll(L.bodyH);
      current = this.column(b.visible(), b.cursor, b.top, L.currentW, L.bodyH, {
        active: this.focus === 'files',
        marked: b.marked,
        empty: b.filter ? '  no matches' : '  folder is empty',
      });
      preview = L.previewW ? this.previewColumn(b.current, L.previewW, L.bodyH) : null;
    }

    let parent = null;
    if (L.parentW) {
      const list = this.parentEntries() || [];
      const here = list.findIndex((e) => e.path === b.cwd);
      let top = 0;
      if (here >= L.bodyH) top = here - Math.floor(L.bodyH / 2);
      this.parentTop = top;
      parent = this.column(list, here, top, L.parentW, L.bodyH, { active: false });
    }
    const side = L.sideW ? this.sidebarColumn(L.sideW, L.bodyH) : null;

    let s = `\x1b[H${this.titleBar()}`;
    for (let i = 0; i < L.bodyH; i++) {
      s += '\r\n';
      if (side) s += side[i] + sep;
      if (parent) s += parent[i] + sep;
      s += current[i];
      if (preview) s += sep + preview[i];
      s += '\x1b[K';
    }
    s += `\r\n${this.pathBar()}\r\n${this.statusBar()}`;
    this.output.write(s);
    if (this.view === 'icons' && !this.search && !this.info) this.renderTooltip(L);
    if (this.info) this.renderInfo();
  }

  renderHelp() {
    const h = this.rows - 2;
    let s = `\x1b[H${barStyle()}${fit('  files — keys', this.cols)}${ansi.reset()}`;
    for (let i = 0; i < h; i++) s += `\r\n${fit(HELP_LINES[this.helpTop + i] ?? '', this.cols)}`;
    s += `\r\n${ansi.fg('gray')}${fit(' any key returns', this.cols)}${ansi.reset()}`;
    this.output.write(s);
  }

  renderInfo() {
    const lines = this.info;
    const w = Math.min(this.cols - 4, Math.max(40, ...lines.map((l) => textWidth(l) + 4)));
    const x = Math.max(1, Math.floor((this.cols - w) / 2));
    const y = Math.max(2, Math.floor((this.rows - lines.length - 2) / 2));
    let s = `\x1b[${y};${x}H${ansi.fg(245)}╭${'─'.repeat(w - 2)}╮${ansi.reset()}`;
    lines.forEach((l, i) => {
      s += `\x1b[${y + i + 1};${x}H${ansi.fg(245)}│${ansi.reset()} ${fit(l, w - 4)} ${ansi.fg(245)}│${ansi.reset()}`;
    });
    s += `\x1b[${y + lines.length + 1};${x}H${ansi.fg(245)}╰${'─'.repeat(w - 2)}╯${ansi.reset()}`;
    this.output.write(s);
  }

  // --- actions ---------------------------------------------------------------

  // Runs a file operation, remembering it for undo and reporting errors.
  act(label, fn, focus) {
    try {
      const record = fn();
      if (record) this.undoStack.push({ label, record });
      this.browser.reload(focus);
      return record;
    } catch (e) {
      this.message = e.message;
      this.browser.reload();
      return null;
    }
  }

  undoLast() {
    const last = this.undoStack.pop();
    if (!last) { this.message = 'nothing to undo'; return; }
    try {
      const restored = ops.undo(last.record);
      const back = restored && restored[0];
      this.browser.reload(back && path.dirname(back) === this.browser.cwd ? path.basename(back) : undefined);
      this.message = `undid ${last.label}`;
    } catch (e) {
      this.message = e.message;
    }
  }

  ask(label, initial, onDone) {
    this.prompt = { label, value: initial || '', onDone };
  }

  newFolder() {
    this.ask('New folder: ', 'untitled folder', (name) => {
      const r = this.act('new folder', () => ops.newFolder(this.browser.cwd, name.trim() || 'untitled folder'));
      if (r) { this.browser.reload(path.basename(r.path)); this.message = `created “${path.basename(r.path)}”`; }
    });
  }

  newFile() {
    this.ask('New file: ', 'untitled.txt', (name) => {
      const r = this.act('new file', () => ops.newFile(this.browser.cwd, name.trim() || 'untitled.txt'));
      if (r) { this.browser.reload(path.basename(r.path)); this.message = `created “${path.basename(r.path)}”`; }
    });
  }

  renameCurrent() {
    const e = this.browser.current;
    if (!e) return;
    this.ask(`Rename “${e.name}” to: `, e.name, (name) => {
      const clean = name.trim();
      if (!clean || clean === e.name) return;
      const r = this.act('rename', () => ops.rename(e.path, clean), clean);
      if (r) this.message = `renamed to “${clean}”`;
    });
  }

  duplicate() {
    const items = this.browser.targets();
    if (!items.length) return;
    const made = [];
    const r = this.act('duplicate', () => {
      for (const e of items) made.push(...ops.duplicate(e.path).paths);
      return { type: 'copy', paths: made };
    });
    if (r && made.length) {
      this.browser.reload(path.basename(made[made.length - 1]));
      this.message = `duplicated ${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`}`;
    }
  }

  copyOrCut(mode) {
    const items = this.browser.targets();
    if (!items.length) return;
    this.clipboard = { mode, paths: items.map((e) => e.path) };
    this.message = `${mode === 'cut' ? 'cut' : 'copied'} ${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`} — p to paste`;
    this.browser.clearMarks();
  }

  paste() {
    const clip = this.clipboard;
    if (!clip) { this.message = 'clipboard is empty'; return; }
    const alive = clip.paths.filter((p) => fs.existsSync(p));
    if (!alive.length) { this.message = 'the clipboard items no longer exist'; this.clipboard = null; return; }
    const dest = this.browser.cwd;
    const r = this.act(clip.mode === 'cut' ? 'move' : 'copy',
      () => (clip.mode === 'cut' ? ops.moveInto(alive, dest) : ops.copyInto(alive, dest)));
    if (r) {
      const made = r.type === 'copy' ? r.paths : r.pairs.map((pr) => pr.to);
      this.browser.reload(path.basename(made[made.length - 1]));
      this.message = `${clip.mode === 'cut' ? 'moved' : 'copied'} ${made.length} item${made.length === 1 ? '' : 's'} here`;
      if (clip.mode === 'cut') this.clipboard = null;
    } else if (!this.message && clip.mode === 'cut') {
      this.message = 'already here';
    }
  }

  trash() {
    const items = this.browser.targets();
    if (!items.length) return;
    const nextName = (() => {
      const list = this.browser.visible();
      const gone = new Set(items.map((e) => e.path));
      const after = list.slice(this.browser.cursor).find((e) => !gone.has(e.path));
      const before = list.slice(0, this.browser.cursor).reverse().find((e) => !gone.has(e.path));
      return (after || before || {}).name;
    })();
    const r = this.act('move to Trash', () => ops.trash(items.map((e) => e.path)), nextName);
    if (r) {
      this.browser.clearMarks();
      this.message = `moved ${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`} to the Trash — u to undo`;
    }
  }

  showInfo() {
    const e = this.search ? this.searchEntry() : this.browser.current;
    if (!e) return;
    let st = null;
    try { st = fs.lstatSync(e.path); } catch { /* gone */ }
    const { kind } = describe(e);
    let size = `${humanBytes(e.size)} (${e.size.toLocaleString()} bytes)`;
    if (e.isDir) {
      const sz = ops.sizeOf(e.path);
      size = `${sz.partial ? 'at least ' : ''}${humanBytes(sz.bytes)} for ${sz.items.toLocaleString()} item${sz.items === 1 ? '' : 's'}`;
    }
    const mode = st ? st.mode : 0;
    const perm = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x']
      .map((c, i) => ((mode >> (8 - i)) & 1 ? c : '-')).join('');
    let owner = '';
    try { owner = st && st.uid === process.getuid() ? os.userInfo().username : String(st.uid); } catch { /* no uid */ }
    this.info = [
      `${ansi.bold()}${ICONS ? `${describe(e).icon} ` : ''}${e.name}${ansi.reset()}`,
      '',
      `Kind:      ${kind}`,
      `Size:      ${size}`,
      `Where:     ${path.dirname(e.path)}`,
      `Created:   ${finderDate(e.birthtime)}`,
      `Modified:  ${finderDate(e.mtime)}`,
      `Access:    ${(st && st.isDirectory()) ? 'd' : '-'}${perm}  ${owner}`,
      ...(e.isLink ? [`Original:  ${(() => { try { return fs.readlinkSync(e.path); } catch { return '?'; } })()}`] : []),
      '',
      `${ansi.fg('gray')}any key closes${ansi.reset()}`,
    ];
  }

  openWithApp(e) {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [e.path], { detached: true, stdio: 'ignore' }).unref();
      this.message = `opened “${e.name}”`;
    } catch (err) {
      this.message = `could not open: ${err.message}`;
    }
  }

  // Space: text in the terminal pager, everything else in macOS Quick Look.
  quickLook(e) {
    if (!e) return;
    if (e.isDir) { this.showInfo(); return; }
    if (isTextual(e)) { this.openInside(e, 'view'); return; }
    if (process.platform === 'darwin') {
      try {
        spawn('qlmanage', ['-p', e.path], { detached: true, stdio: 'ignore' }).unref();
        this.message = `Quick Look: “${e.name}”`;
        return;
      } catch { /* fall back to open */ }
    }
    this.openWithApp(e);
  }

  openInside(entry, how) {
    if (this.mouse) this.output.write(MOUSE_OFF);
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
    this.browser.reload(entry.name);
    this.output.write(`\x1b[2J${this.mouse ? MOUSE_ON : ''}`);
  }

  openEntry(e) {
    if (!e) return;
    if (e.isDir) { this.browser.goTo(e.path); return; }
    if (isTextual(e)) this.openInside(e, 'edit');
    else this.openWithApp(e);
  }

  // --- the mouse ----------------------------------------------------------------

  // What is under screen position (x, y), both 1-based.
  hitTest(x, y) {
    const L = this.layout();
    const bodyTop = 2;
    const bodyBottom = L.bodyH + 1;

    if (y === L.bodyH + 2) {
      const seg = this.pathSegs.find((p) => x >= p.from && x <= p.to);
      return seg ? { area: 'path', path: seg.path } : null;
    }
    if (y < bodyTop || y > bodyBottom) return null;
    const row = y - bodyTop;

    let left = 1;
    if (L.sideW) {
      if (x < left + L.sideW) {
        const item = this.sidebar[row];
        return item && item.path ? { area: 'sidebar', index: row } : null;
      }
      left += L.sideW + 1;
    }

    if (this.search) {
      if (x < left || x >= left + L.currentW) return null;
      const index = this.search.top + row;
      return index < this.search.results.length ? { area: 'result', index } : null;
    }

    if (this.view === 'icons') {
      if (x < left || x >= left + L.currentW) return null;
      const col = Math.floor((x - left) / L.cellW);
      if (col >= L.perRow) return null;
      const index = (this.gridTop + Math.floor(row / CELL_H)) * L.perRow + col;
      return index < this.browser.visible().length ? { area: 'item', index } : null;
    }

    if (L.parentW) {
      if (x < left + L.parentW) {
        const list = this.parentEntries() || [];
        const index = this.parentTop + row;
        return index < list.length ? { area: 'parent', entry: list[index] } : null;
      }
      left += L.parentW + 1;
    }
    if (x < left || x >= left + L.currentW) return null;
    const index = this.browser.top + row;
    return index < this.browser.visible().length ? { area: 'item', index } : null;
  }

  // A second click on the same thing within DOUBLE_CLICK_MS is a double click.
  isDoubleClick(id) {
    const now = Date.now();
    const double = !!this.lastClick && this.lastClick.id === id && now - this.lastClick.t < DOUBLE_CLICK_MS;
    this.lastClick = double ? null : { id, t: now };
    return double;
  }

  handleMouse(ev) {
    if (ev.release || ev.drag) return;
    if (this.info) { this.info = null; return; }
    if (this.mode === 'help' || this.prompt || this.filtering) return;
    const b = this.browser;
    this.message = '';

    if (ev.button === 64 || ev.button === 65) {
      const dir = ev.button === 64 ? -1 : 1;
      if (this.search) {
        const s = this.search;
        s.cursor = Math.max(0, Math.min(s.results.length - 1, s.cursor + dir));
      } else if (this.view === 'icons') {
        const per = this.layout().perRow;
        const count = b.visible().length;
        const to = b.cursor + dir * per;
        if (to >= 0 && to < count) b.cursor = to;
      } else {
        b.move(dir * 3);
      }
      return;
    }
    if (ev.button !== 0) return;

    const hit = this.hitTest(ev.x, ev.y);
    if (!hit) return;

    switch (hit.area) {
      case 'sidebar': {
        this.sideIndex = hit.index;
        this.focus = 'files';
        b.goTo(this.sidebar[hit.index].path);
        return;
      }
      case 'path': {
        if (hit.path === b.cwd) return;
        const child = path.relative(hit.path, b.cwd).split(path.sep)[0];
        b.goTo(hit.path, child || null);
        return;
      }
      case 'parent': {
        const e = hit.entry;
        if (e.isDir) b.goTo(e.path);
        else b.goTo(path.dirname(e.path), e.name);
        return;
      }
      case 'result': {
        this.search.cursor = hit.index;
        if (this.isDoubleClick(`result:${this.search.results[hit.index]}`)) this.handleSearchKey({ name: 'return' });
        return;
      }
      case 'item': {
        this.focus = 'files';
        b.cursor = hit.index;
        const e = b.current;
        if (e && this.isDoubleClick(`item:${e.path}`)) this.openEntry(e);
        return;
      }
      default:
    }
  }

  // --- keys --------------------------------------------------------------------

  handlePromptKey(key) {
    const p = this.prompt;
    if (key.name === 'return') { this.prompt = null; p.onDone(p.value); return; }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.prompt = null; this.message = 'cancelled'; return; }
    if (key.name === 'backspace') { p.value = p.value.slice(0, -1); return; }
    if (key.ctrl && key.name === 'u') { p.value = ''; return; }
    if (key.printable) p.value += key.str;
  }

  handleSearchKey(key) {
    const s = this.search;
    switch (key.name) {
      case 'up': s.cursor = Math.max(0, s.cursor - 1); return;
      case 'down': s.cursor = Math.min(Math.max(0, s.results.length - 1), s.cursor + 1); return;
      case 'escape': case 'left': case 'q': this.search = null; this.message = ''; return;
      case 'return': case 'right': {
        const p = this.searchCurrent();
        if (!p) return;
        this.search = null;
        this.browser.goTo(path.dirname(p), path.basename(p));
        this.message = `revealed “${path.basename(p)}”`;
        return;
      }
      case 'space': case ' ': this.quickLook(this.searchEntry()); return;
      case 'i': this.showInfo(); return;
      default:
    }
  }

  handleSidebarKey(key) {
    const items = this.sidebar;
    const step = (d) => {
      let i = this.sideIndex;
      do { i += d; } while (i >= 0 && i < items.length && !items[i].path);
      if (i >= 0 && i < items.length) this.sideIndex = i;
    };
    switch (key.name) {
      case 'up': step(-1); return;
      case 'down': step(1); return;
      case 'return': case 'right': {
        const s = items[this.sideIndex];
        if (s && s.path) this.browser.goTo(s.path);
        this.focus = 'files';
        return;
      }
      case 'tab': case 'escape': case 'left': this.focus = 'files'; return;
      default:
    }
  }

  handleKey(key) {
    const b = this.browser;
    if (key.name === 'eof') { this.done = true; return; }
    if (key.name === 'mouse') { this.handleMouse(key); return; }
    if (this.info) { this.info = null; return; }
    if (this.mode === 'help') {
      if (key.name === 'down') this.helpTop++;
      else if (key.name === 'up') this.helpTop = Math.max(0, this.helpTop - 1);
      else { this.mode = 'browse'; this.helpTop = 0; }
      return;
    }
    if (this.prompt) { this.handlePromptKey(key); return; }
    if (this.filtering) {
      if (key.name === 'return') { this.filtering = false; return; }
      if (key.name === 'escape') { this.filtering = false; b.setFilter(''); return; }
      if (key.name === 'backspace') { b.setFilter(b.filter.slice(0, -1)); return; }
      if (key.name === 'up' || key.name === 'down') { b.move(key.name === 'up' ? -1 : 1); return; }
      if (key.printable) b.setFilter(b.filter + key.str);
      return;
    }

    this.message = '';
    if (key.ctrl && key.name === 'c') { this.done = true; return; }
    if (key.ctrl && key.name === 'z') { this.undoLast(); return; }
    if (key.ctrl && key.name === 'l') { b.reload(); this.output.write('\x1b[2J'); return; }
    if (this.search) { this.handleSearchKey(key); return; }
    if (this.focus === 'sidebar') { this.handleSidebarKey(key); return; }

    const L = this.layout();
    const height = L.bodyH;
    if (this.view === 'icons') {
      const per = L.perRow;
      const count = b.visible().length;
      const moveGrid = (n) => {
        const to = b.cursor + n;
        if (to < 0 || !count) return;
        b.cursor = Math.min(count - 1, to);
      };
      switch (key.name) {
        case 'left': case 'h': moveGrid(-1); return;
        case 'right': case 'l': moveGrid(1); return;
        case 'up': case 'k': moveGrid(-per); return;
        case 'down': case 'j':
          if (Math.floor(b.cursor / per) < Math.floor((count - 1) / per)) moveGrid(per);
          return;
        case 'pageup': moveGrid(-per * L.rowsVisible); return;
        case 'pagedown': moveGrid(per * L.rowsVisible); return;
        default:
      }
    }
    if (key.printable && /^[1-9]$/.test(key.str)) {
      const favs = this.sidebar.filter((s) => s.path);
      const s = favs[Number(key.str) - 1];
      if (s) b.goTo(s.path);
      return;
    }

    switch (key.name) {
      case 'q': this.done = true; this.cdOnExit = true; break;
      case 'Q': this.done = true; break;
      case 'escape':
        if (b.marked.size) { b.clearMarks(); this.message = 'selection cleared'; }
        else if (b.filter) b.setFilter('');
        break;
      case 'up': case 'k': b.move(-1); break;
      case 'down': case 'j': b.move(1); break;
      case 'pageup': b.move(-height); break;
      case 'pagedown': b.move(height); break;
      case 'g': case 'home': b.moveTo(0); break;
      case 'G': case 'end': b.moveTo(Number.MAX_SAFE_INTEGER); break;
      case 'left': case 'h': case 'backspace': b.up(); break;
      case 'right': case 'l': if (b.current && b.current.isDir) b.goTo(b.current.path); break;
      case 'return': this.openEntry(b.current); break;
      case 'space': case ' ': this.quickLook(b.current); break;
      case '[': if (!b.back()) this.message = 'no earlier folder'; break;
      case ']': if (!b.forward()) this.message = 'no later folder'; break;
      case 'tab': if (this.layout().sideW) this.focus = 'sidebar'; break;
      case 'b': this.showSidebar = !this.showSidebar; break;
      case 'V':
        this.view = this.view === 'icons' ? 'columns' : 'icons';
        this.message = this.view === 'icons' ? 'icon view' : 'column view';
        this.output.write('\x1b[2J');
        break;
      case '~': b.goTo(os.homedir()); break;
      case 'o': if (b.current) this.openWithApp(b.current); break;
      case 'e': if (b.current && !b.current.isDir) this.openInside(b.current, 'edit'); break;
      case 'v': if (b.current && !b.current.isDir) this.openInside(b.current, 'view'); break;
      case 'n': this.newFolder(); break;
      case 'N': this.newFile(); break;
      case 'r': this.renameCurrent(); break;
      case 'd': this.duplicate(); break;
      case 'c': this.copyOrCut('copy'); break;
      case 'x': this.copyOrCut('cut'); break;
      case 'p': this.paste(); break;
      case 't': case 'delete': this.trash(); break;
      case 'u': this.undoLast(); break;
      case 'm': b.toggleMark(); b.move(1); break;
      case 'a': b.markAll(); this.message = `selected ${b.marked.size} items`; break;
      case 'A': b.clearMarks(); break;
      case 's': this.message = `sorted by ${b.cycleSort()}`; break;
      case '.': b.toggleHidden(); this.message = b.showHidden ? 'showing hidden files' : 'hiding hidden files'; break;
      case 'i': this.showInfo(); break;
      case '/': this.filtering = true; break;
      case 'f':
        this.ask('Search in this folder: ', '', (q) => {
          if (!q.trim()) return;
          const { results, truncated } = ops.search(b.cwd, q.trim(), { showHidden: b.showHidden });
          this.search = { query: q.trim(), results, cursor: 0, top: 0 };
          this.message = `${results.length}${truncated ? '+' : ''} found — Enter reveals, Esc returns`;
        });
        break;
      case '?': this.mode = 'help'; break;
      default: break;
    }
  }

  loop() {
    const reader = new KeyReader(0);
    this.render();
    while (!this.done) {
      const key = reader.next(POLL_MS);
      if (key.name === 'timeout') {
        // Like Finder, pick up changes made by other programs.
        if (!this.prompt && this.browser.changedOnDisk()) { this.browser.reload(); this.render(); }
        continue;
      }
      this.handleKey(key);
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
  screen.mouse = !args.includes('--no-mouse');
  fullscreen(() => screen.loop(), { cursor: false, mouse: screen.mouse });

  if (screen.cdOnExit && browser.cwd !== shell.cwd) {
    try { shell.setCwd(browser.cwd); } catch { /* directory vanished */ }
  }
  return 0;
}

module.exports = {
  FileBrowser, FilesScreen, previewOf, runFiles,
  describe, isTextual, finderDate, sortEntries, readEntries, sidebarItems,
  finderLabel, middleTruncate, iconArt, ART_W, CELL_H,
};
