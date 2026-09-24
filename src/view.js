'use strict';

const fs = require('fs');
const path = require('path');

const ansi = require('./ansi');
const { KeyReader } = require('./keys');
const { computeStates, renderSlice, detectLanguage, sniffLanguage } = require('./syntax');
const { fullscreen, requireTty, bar } = require('./tui');

const FOLLOW_POLL_MS = 500;

// --- the model: everything but the terminal ----------------------------------

class Pager {
  constructor(text, { lang, name = '' } = {}) {
    this.name = name;
    this.setText(text);
    this.lang = lang || (name ? detectLanguage(name, this.lines[0]) : sniffLanguage(text));
    this.top = 0;
    this.left = 0;
    this.height = 20;
    this.showNumbers = false;
    this.search = '';
    this.matches = [];
    this.matchIndex = -1;
    this.following = false;
  }

  setText(text) {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    this.lines = body.length ? body.split('\n') : [''];
    this.states = null;
    if (this.search) this.findAll(this.search);
  }

  get lastTop() { return Math.max(0, this.lines.length - this.height); }

  get atEnd() { return this.top >= this.lastTop; }

  syntaxStates() {
    if (!this.states) this.states = computeStates(this.lang, this.lines);
    return this.states;
  }

  scrollTo(row) { this.top = Math.max(0, Math.min(this.lastTop, row)); }

  scrollBy(n) { this.scrollTo(this.top + n); }

  pageDown() { this.scrollBy(this.height); }

  pageUp() { this.scrollBy(-this.height); }

  home() { this.scrollTo(0); }

  end() { this.scrollTo(this.lastTop); }

  // Case-insensitive unless the term has a capital, like less and vim.
  findAll(term) {
    this.search = term;
    this.matches = [];
    this.matchIndex = -1;
    if (!term) return 0;
    const caseSensitive = /[A-Z]/.test(term);
    const needle = caseSensitive ? term : term.toLowerCase();
    this.lines.forEach((line, row) => {
      const hay = caseSensitive ? line : line.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1) {
        this.matches.push({ row, col: at, len: term.length });
        at = hay.indexOf(needle, at + Math.max(1, needle.length));
      }
    });
    return this.matches.length;
  }

  // Jumps to the next (or previous) match from the top of the screen.
  nextMatch(direction = 1) {
    if (!this.matches.length) return null;
    let idx;
    if (this.matchIndex === -1) {
      idx = direction > 0
        ? this.matches.findIndex((m) => m.row >= this.top)
        : this.matches.map((m) => m.row < this.top).lastIndexOf(true);
      if (idx === -1) idx = direction > 0 ? 0 : this.matches.length - 1;
    } else {
      idx = (this.matchIndex + direction + this.matches.length) % this.matches.length;
    }
    this.matchIndex = idx;
    const m = this.matches[idx];
    if (m.row < this.top || m.row >= this.top + this.height) this.scrollTo(m.row - Math.floor(this.height / 3));
    return m;
  }

  matchesOnRow(row) {
    return this.matches.filter((m) => m.row === row).map((m) => [m.col, m.col + m.len]);
  }
}

// --- the screen -------------------------------------------------------------

const KEYS_HELP = 'q quit  / search  n N next/prev  g G top/end  # numbers  F follow  ←→ scroll';

class PagerScreen {
  constructor(pager, { file = null, output = process.stdout } = {}) {
    this.pager = pager;
    this.file = file;
    this.output = output;
    this.prompt = null;
    this.message = '';
    this.done = false;
    this.fileSig = file ? statSig(file) : null;
  }

  get rows() { return this.output.rows || 24; }

  get cols() { return this.output.columns || 80; }

  render() {
    const p = this.pager;
    p.height = Math.max(1, this.rows - 2);
    if (p.following) p.end();
    else p.scrollTo(p.top);

    const gutter = p.showNumbers ? String(p.lines.length).length + 1 : 0;
    const width = Math.max(1, this.cols - gutter);
    const states = p.syntaxStates();

    const where = p.lines.length <= p.height
      ? 'all'
      : `${Math.round(((p.top + p.height) / p.lines.length) * 100)}%`;
    const mode = p.following ? '  following' : '';
    let s = '\x1b[H';
    s += bar(`  ${p.name || 'stdin'}  [${p.lang.name}]  ${p.lines.length} lines  ${where}${mode}`, this.cols);

    for (let i = 0; i < p.height; i++) {
      const row = p.top + i;
      s += '\r\n';
      if (row >= p.lines.length) { s += `${ansi.fg('gray')}~${ansi.reset()}\x1b[K`; continue; }
      if (gutter) s += `${ansi.fg('gray')}${String(row + 1).padStart(gutter - 1)}${ansi.reset()} `;
      s += renderSlice(p.lang, p.lines[row], states[row] || null, p.left, p.left + width, p.matchesOnRow(row));
      s += '\x1b[K';
    }

    s += '\r\n';
    if (this.prompt) s += `${this.prompt.label}${this.prompt.value}\x1b[K`;
    else if (this.message) s += `${ansi.fg(214)}${this.message}${ansi.reset()}\x1b[K`;
    else s += `${ansi.fg('gray')}${KEYS_HELP}${ansi.reset()}\x1b[K`;

    this.output.write(s);
  }

  // Re-reads a followed file when it grows or changes.
  poll() {
    if (!this.file || !this.pager.following) return false;
    const sig = statSig(this.file);
    if (sig === this.fileSig) return false;
    this.fileSig = sig;
    try {
      this.pager.setText(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return false;
    }
    return true;
  }

  handlePrompt(key) {
    const pr = this.prompt;
    if (key.name === 'return') {
      this.prompt = null;
      const n = this.pager.findAll(pr.value);
      if (!n) { this.message = `pattern not found: ${pr.value}`; return; }
      this.pager.following = false;
      this.pager.nextMatch(pr.direction);
      this.message = `${n} match${n === 1 ? '' : 'es'}`;
      return;
    }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.prompt = null; return; }
    if (key.name === 'backspace') {
      if (!pr.value) { this.prompt = null; return; }
      pr.value = pr.value.slice(0, -1);
      return;
    }
    if (key.printable) pr.value += key.str;
  }

  handleKey(key) {
    if (key.name === 'eof') { this.done = true; return; }
    if (this.prompt) { this.handlePrompt(key); return; }
    this.message = '';
    const p = this.pager;
    const moving = () => { p.following = false; };

    if (key.ctrl) {
      if (key.name === 'c') this.done = true;
      else if (key.name === 'f' || key.name === 'v') { moving(); p.pageDown(); }
      else if (key.name === 'b') { moving(); p.pageUp(); }
      else if (key.name === 'd') { moving(); p.scrollBy(Math.floor(p.height / 2)); }
      else if (key.name === 'u') { moving(); p.scrollBy(-Math.floor(p.height / 2)); }
      return;
    }

    switch (key.name) {
      case 'q': case 'Q': case 'escape': this.done = true; break;
      case 'down': case 'j': case 'return': moving(); p.scrollBy(1); break;
      case 'up': case 'k': case 'y': moving(); p.scrollBy(-1); break;
      case 'space': case ' ': case 'pagedown': case 'f': moving(); p.pageDown(); break;
      case 'pageup': case 'b': moving(); p.pageUp(); break;
      case 'd': moving(); p.scrollBy(Math.floor(p.height / 2)); break;
      case 'u': moving(); p.scrollBy(-Math.floor(p.height / 2)); break;
      case 'g': case '<': case 'home': moving(); p.home(); break;
      case 'G': case '>': case 'end': p.end(); break;
      case 'left': case 'h': p.left = Math.max(0, p.left - 8); break;
      case 'right': case 'l': p.left += 8; break;
      case '#': p.showNumbers = !p.showNumbers; break;
      case '/': this.prompt = { label: '/', value: '', direction: 1 }; break;
      case '?': this.prompt = { label: '?', value: '', direction: -1 }; break;
      case 'n': moving(); if (!p.nextMatch(1)) this.message = 'no search'; break;
      case 'N': moving(); if (!p.nextMatch(-1)) this.message = 'no search'; break;
      case 'F':
        if (!this.file) { this.message = 'follow needs a file, not a pipe'; break; }
        p.following = !p.following;
        if (p.following) { this.poll(); p.end(); }
        this.message = p.following ? 'following — new lines appear as the file grows' : 'stopped following';
        break;
      default: break;
    }
  }

  loop() {
    const reader = new KeyReader(0);
    this.render();
    while (!this.done) {
      const key = reader.next(FOLLOW_POLL_MS);
      if (key.name === 'timeout') {
        if (this.poll()) this.render();
        continue;
      }
      this.handleKey(key);
      if (!this.done) this.render();
    }
    return 0;
  }
}

function statSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

// The `view` builtin: view FILE, or  ... | view
function runView(args, io, shell) {
  const files = args.filter((a) => !a.startsWith('-') || a === '-');
  const numbers = args.includes('-n') || args.includes('--numbers');
  const follow = args.includes('-f') || args.includes('--follow');

  let text;
  let name = '';
  let file = null;

  if (files.length && files[0] !== '-') {
    name = files[0];
    file = shell.resolve(name);
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      shell.writeTo(io.stderr, `view: ${name}: ${e.code === 'ENOENT' ? 'no such file' : e.code || e.message}\n`);
      return 1;
    }
  } else if (io.stdin && io.stdin.kind === 'string') {
    text = shell.readAll(io.stdin);
  } else {
    shell.writeTo(io.stderr, 'usage: view FILE   or   command | view\n');
    return 2;
  }

  // Not at a terminal (e.g. view file > out): behave like cat.
  const toTerminal = io.stdout.kind === 'term' && process.stdout.isTTY && !shell.output;
  if (!toTerminal) {
    shell.writeTo(io.stdout, text);
    return 0;
  }
  if (!requireTty('view', io, shell)) return 1;

  const pager = new Pager(text, { name: name ? path.basename(name) : '' });
  pager.showNumbers = numbers;
  const screen = new PagerScreen(pager, { file });
  if (follow && file) { pager.following = true; }

  return fullscreen(() => screen.loop(), { cursor: false });
}

module.exports = { Pager, PagerScreen, runView };
