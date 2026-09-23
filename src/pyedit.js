'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const { KeyReader } = require('./keys');
const { computeStates, renderSlice } = require('./pyhighlight');
const { findInPath } = require('./builtins');

const TAB_WIDTH = 4;
const INDENT = ' '.repeat(TAB_WIDTH);
const UNDO_LIMIT = 300;

// --- the document model (pure, so it can be tested without a terminal) ------

class EditorBuffer {
  constructor(text = '') {
    this.lines = text.length ? text.split('\n') : [''];
    if (!this.lines.length) this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.modified = false;
    this.undoStack = [];
    this.redoStack = [];
    this.cutBuffer = [];
    this.lastWasCut = false;
  }

  get text() { return this.lines.join('\n'); }

  get line() { return this.lines[this.row] ?? ''; }

  snapshot() {
    return { lines: this.lines.slice(), row: this.row, col: this.col };
  }

  pushUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  restore(state) {
    this.lines = state.lines.slice();
    this.row = Math.min(state.row, this.lines.length - 1);
    this.col = Math.min(state.col, this.lines[this.row].length);
  }

  undo() {
    const state = this.undoStack.pop();
    if (!state) return false;
    this.redoStack.push(this.snapshot());
    this.restore(state);
    this.modified = true;
    return true;
  }

  redo() {
    const state = this.redoStack.pop();
    if (!state) return false;
    this.undoStack.push(this.snapshot());
    this.restore(state);
    this.modified = true;
    return true;
  }

  clamp() {
    this.row = Math.max(0, Math.min(this.row, this.lines.length - 1));
    this.col = Math.max(0, Math.min(this.col, this.line.length));
  }

  insert(text) {
    this.pushUndo();
    const l = this.line;
    this.lines[this.row] = l.slice(0, this.col) + text + l.slice(this.col);
    this.col += text.length;
    this.modified = true;
  }

  // Enter keeps the current indentation, and adds a level after `:` or an
  // opening bracket — the thing that makes editing Python bearable.
  newline() {
    this.pushUndo();
    const l = this.line;
    const before = l.slice(0, this.col);
    const after = l.slice(this.col);
    let indent = /^[ \t]*/.exec(before)[0];
    const code = before.replace(/#.*$/, '').trimEnd();
    if (/[:([{]$/.test(code)) indent += INDENT;
    this.lines[this.row] = before;
    this.lines.splice(this.row + 1, 0, indent + after);
    this.row++;
    this.col = indent.length;
    this.modified = true;
  }

  backspace() {
    if (this.col > 0) {
      const before = this.line.slice(0, this.col);
      // Inside leading whitespace, delete a whole indent stop.
      const span = /^[ ]+$/.test(before) && this.col % TAB_WIDTH === 0 ? TAB_WIDTH : 1;
      this.pushUndo();
      this.lines[this.row] = this.line.slice(0, this.col - span) + this.line.slice(this.col);
      this.col -= span;
      this.modified = true;
      return;
    }
    if (this.row === 0) return;
    this.pushUndo();
    const prev = this.lines[this.row - 1];
    this.col = prev.length;
    this.lines[this.row - 1] = prev + this.line;
    this.lines.splice(this.row, 1);
    this.row--;
    this.modified = true;
  }

  deleteChar() {
    if (this.col < this.line.length) {
      this.pushUndo();
      this.lines[this.row] = this.line.slice(0, this.col) + this.line.slice(this.col + 1);
      this.modified = true;
      return;
    }
    if (this.row >= this.lines.length - 1) return;
    this.pushUndo();
    this.lines[this.row] = this.line + this.lines[this.row + 1];
    this.lines.splice(this.row + 1, 1);
    this.modified = true;
  }

  indent() {
    this.pushUndo();
    this.lines[this.row] = INDENT + this.line;
    this.col += TAB_WIDTH;
    this.modified = true;
  }

  dedent() {
    const m = /^[ ]{1,4}/.exec(this.line);
    if (!m) return;
    this.pushUndo();
    this.lines[this.row] = this.line.slice(m[0].length);
    this.col = Math.max(0, this.col - m[0].length);
    this.modified = true;
  }

  toggleComment() {
    this.pushUndo();
    const l = this.line;
    const m = /^(\s*)(#\s?)?(.*)$/.exec(l);
    this.lines[this.row] = m[2] ? m[1] + m[3] : `${m[1]}# ${m[3]}`;
    this.col = Math.max(0, this.col + (m[2] ? -m[2].length : 2));
    this.modified = true;
  }

  cutLine() {
    this.pushUndo();
    if (!this.lastWasCut) this.cutBuffer = [];
    this.cutBuffer.push(this.lines[this.row]);
    this.lines.splice(this.row, 1);
    if (!this.lines.length) this.lines = [''];
    this.row = Math.min(this.row, this.lines.length - 1);
    this.col = 0;
    this.modified = true;
  }

  paste() {
    if (!this.cutBuffer.length) return;
    this.pushUndo();
    this.lines.splice(this.row, 0, ...this.cutBuffer);
    this.row += this.cutBuffer.length;
    this.row = Math.min(this.row, this.lines.length - 1);
    this.col = 0;
    this.modified = true;
  }

  moveLeft() {
    if (this.col > 0) { this.col--; return; }
    if (this.row > 0) { this.row--; this.col = this.line.length; }
  }

  moveRight() {
    if (this.col < this.line.length) { this.col++; return; }
    if (this.row < this.lines.length - 1) { this.row++; this.col = 0; }
  }

  moveUp(n = 1) { this.row = Math.max(0, this.row - n); this.clamp(); }

  moveDown(n = 1) { this.row = Math.min(this.lines.length - 1, this.row + n); this.clamp(); }

  home() {
    const indent = /^[ \t]*/.exec(this.line)[0].length;
    this.col = this.col === indent ? 0 : indent;
  }

  end() { this.col = this.line.length; }

  gotoLine(n) {
    this.row = Math.max(0, Math.min(this.lines.length - 1, n - 1));
    this.col = 0;
  }

  find(term, fromRow = this.row, fromCol = this.col + 1) {
    if (!term) return null;
    const total = this.lines.length;
    for (let k = 0; k <= total; k++) {
      const r = (fromRow + k) % total;
      const start = k === 0 ? fromCol : 0;
      const idx = this.lines[r].indexOf(term, start);
      if (idx !== -1) return { row: r, col: idx };
    }
    return null;
  }
}

// --- the screen -------------------------------------------------------------

const HELP_ROWS = [
  [['^O', 'Save'], ['^X', 'Exit'], ['^W', 'Find'], ['^T', 'Run'], ['^G', 'Help'], ['^K', 'Cut']],
  [['^U', 'Paste'], ['^Z', 'Undo'], ['M-3', 'Comment'], ['Tab', 'Indent'], ['M-N', 'Numbers'], ['^_', 'Go to']],
];

class PyEditor {
  constructor({ shell, io, filename, text, input, output }) {
    this.shell = shell;
    this.io = io;
    this.input = input || process.stdin;
    this.output = output || process.stdout;
    this.filename = filename || '';
    this.buf = new EditorBuffer(text || '');
    this.topRow = 0;
    this.leftCol = 0;
    this.message = filename ? '' : 'New buffer';
    this.showNumbers = true;
    this.mode = 'edit';
    this.prompt = null;
    this.view = null;
    this.viewTop = 0;
    this.searchTerm = '';
    this.done = false;
    this.status = 0;
    this.stateVersion = -1;
    this.states = [];
  }

  get rows() { return this.output.rows || 24; }

  get cols() { return this.output.columns || 80; }

  get bodyRows() { return Math.max(1, this.rows - 4); }

  get gutter() { return this.showNumbers ? String(this.buf.lines.length).length + 1 : 0; }

  pythonPath() {
    if (this._python !== undefined) return this._python;
    this._python = findInPath('python3', this.shell) || findInPath('python', this.shell) || null;
    return this._python;
  }

  syntaxState() {
    // Triple-quote state is only recomputed when the document changes.
    const version = this.buf.lines.length + this.buf.text.length;
    if (version !== this.stateVersion) {
      this.states = computeStates(this.buf.lines);
      this.stateVersion = version;
    }
    return this.states;
  }

  // --- rendering ------------------------------------------------------------

  bar(text) {
    const padded = text.length > this.cols ? text.slice(0, this.cols) : text.padEnd(this.cols);
    return `\x1b[7m${padded}\x1b[0m`;
  }

  titleBar() {
    const name = this.filename || 'new buffer';
    const flag = this.buf.modified ? '  Modified' : '';
    const left = `  maxshell pyedit  ${name}`;
    const room = this.cols - left.length - flag.length;
    return this.bar(left + (room > 0 ? ' '.repeat(room) : '') + flag);
  }

  helpBars() {
    return HELP_ROWS.map((row) => {
      let s = '';
      for (const [k, label] of row) s += `\x1b[7m${k}\x1b[0m ${label.padEnd(9)}`;
      return `${s}\x1b[K`;
    });
  }

  scroll() {
    const body = this.bodyRows;
    if (this.buf.row < this.topRow) this.topRow = this.buf.row;
    if (this.buf.row >= this.topRow + body) this.topRow = this.buf.row - body + 1;
    const width = Math.max(1, this.cols - this.gutter);
    if (this.buf.col < this.leftCol) this.leftCol = this.buf.col;
    if (this.buf.col >= this.leftCol + width) this.leftCol = this.buf.col - width + 1;
  }

  render() {
    if (this.mode === 'help') return this.renderPager('pyedit help', HELP_TEXT_LINES);
    if (this.mode === 'output') return this.renderPager('output — any key returns', this.view || []);

    this.scroll();
    const states = this.syntaxState();
    const width = Math.max(1, this.cols - this.gutter);
    const gutterWidth = this.gutter;

    let s = '\x1b[H';
    s += this.titleBar();

    for (let i = 0; i < this.bodyRows; i++) {
      const row = this.topRow + i;
      s += `\r\n`;
      if (row >= this.buf.lines.length) { s += `${ansi.fg('gray')}~${ansi.reset()}\x1b[K`; continue; }
      if (gutterWidth) {
        const num = String(row + 1).padStart(gutterWidth - 1);
        const color = row === this.buf.row ? ansi.fg(250) : ansi.fg('gray');
        s += `${color}${num}${ansi.reset()} `;
      }
      s += renderSlice(this.buf.lines[row], states[row] || null, this.leftCol, this.leftCol + width);
      s += '\x1b[K';
    }

    s += '\r\n';
    if (this.mode === 'prompt') {
      s += this.bar(` ${this.prompt.label}${this.prompt.value}`);
    } else {
      const pos = `line ${this.buf.row + 1}/${this.buf.lines.length}  col ${this.buf.col + 1}`;
      const msg = this.message ? `  ${this.message}` : '';
      s += `${ansi.fg('gray')}${pos}${ansi.reset()}${ansi.fg(214)}${msg}${ansi.reset()}\x1b[K`;
    }

    for (const bar of this.helpBars()) s += `\r\n${bar}`;

    // Park the cursor where the user is typing.
    if (this.mode === 'prompt') {
      s += `\x1b[${this.rows - 2};${this.prompt.label.length + this.prompt.value.length + 2}H`;
    } else {
      const screenRow = 2 + (this.buf.row - this.topRow);
      const screenCol = gutterWidth + (this.buf.col - this.leftCol) + 1;
      s += `\x1b[${screenRow};${screenCol}H`;
    }

    this.output.write(s);
  }

  renderPager(title, lines) {
    let s = '\x1b[H';
    s += this.bar(`  ${title}`);
    const body = this.rows - 2;
    for (let i = 0; i < body; i++) {
      const line = lines[this.viewTop + i];
      s += `\r\n${line === undefined ? '' : line.slice(0, this.cols)}\x1b[K`;
    }
    s += `\r\n${this.bar('  ↑/↓ scroll   any other key returns')}`;
    this.output.write(s);
  }

  // --- actions --------------------------------------------------------------

  askPrompt(label, initial, onDone) {
    this.mode = 'prompt';
    this.prompt = { label, value: initial || '', onDone };
  }

  save(name) {
    const target = name || this.filename;
    if (!target) { this.askPrompt('File name to write: ', '', (v) => this.save(v)); return; }
    try {
      fs.writeFileSync(this.shell.resolve(target), this.buf.text);
    } catch (e) {
      this.message = `cannot write ${target}: ${e.code || e.message}`;
      return;
    }
    this.filename = target;
    this.buf.modified = false;
    const lines = this.buf.lines.length;
    const problem = /\.py$/.test(target) ? this.checkSyntax() : null;
    this.message = problem
      ? `wrote ${lines} lines — ${problem}`
      : `wrote ${lines} lines`;
  }

  checkSyntax() {
    const py = this.pythonPath();
    if (!py) return null;
    const res = spawnSync(py, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
      input: this.buf.text, encoding: 'utf8', timeout: 10000,
    });
    if (!res || res.error || res.status === 0) return null;
    const err = (res.stderr || '').trim().split('\n');
    const detail = err[err.length - 1] || 'syntax error';
    const where = /line (\d+)/.exec(res.stderr || '');
    return where ? `${detail} (line ${where[1]})` : detail;
  }

  runPython() {
    const py = this.pythonPath();
    if (!py) { this.message = 'python3 not found on PATH'; return; }
    const res = spawnSync(py, ['-'], {
      input: this.buf.text,
      encoding: 'utf8',
      cwd: this.shell.cwd,
      env: this.shell.env,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    const header = `$ ${path.basename(py)} ${this.filename || '-'}   (exit ${res.status ?? '?'})`;
    this.view = [header, ''].concat(out.split('\n'));
    this.viewTop = 0;
    this.mode = 'output';
  }

  tryExit() {
    if (!this.buf.modified) { this.done = true; return; }
    this.askPrompt('Save modified buffer? (y/n) ', '', (value) => {
      const answer = value.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') { this.save(); this.done = !this.buf.modified; return; }
      if (answer === 'n' || answer === 'no') { this.done = true; return; }
      this.message = 'cancelled';
    });
  }

  doSearch(term) {
    if (!term) return;
    this.searchTerm = term;
    const hit = this.buf.find(term);
    if (!hit) { this.message = `"${term}" not found`; return; }
    this.buf.row = hit.row;
    this.buf.col = hit.col;
    this.message = `found "${term}"`;
  }

  // --- key handling ---------------------------------------------------------

  handlePrompt(key) {
    const p = this.prompt;
    if (key.name === 'return') {
      this.mode = 'edit';
      this.prompt = null;
      p.onDone(p.value);
      return;
    }
    if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
      this.mode = 'edit';
      this.prompt = null;
      this.message = 'cancelled';
      return;
    }
    if (key.name === 'backspace') { p.value = p.value.slice(0, -1); return; }
    if (key.printable) p.value += key.str;
  }

  handlePager(key) {
    if (key.name === 'up') { this.viewTop = Math.max(0, this.viewTop - 1); return; }
    if (key.name === 'down') { this.viewTop++; return; }
    if (key.name === 'pageup') { this.viewTop = Math.max(0, this.viewTop - (this.rows - 3)); return; }
    if (key.name === 'pagedown') { this.viewTop += this.rows - 3; return; }
    this.mode = 'edit';
    this.view = null;
  }

  handleKey(key) {
    if (key.name === 'eof') { this.done = true; return; }
    if (this.mode === 'prompt') return this.handlePrompt(key);
    if (this.mode === 'help' || this.mode === 'output') return this.handlePager(key);

    this.message = '';
    const wasCut = key.ctrl && key.name === 'k';

    if (key.ctrl) {
      switch (key.name) {
        case 'x': this.tryExit(); break;
        case 'o': this.askPrompt('File name to write: ', this.filename, (v) => this.save(v)); break;
        case 'g': this.mode = 'help'; this.viewTop = 0; break;
        case 'k': this.buf.cutLine(); break;
        case 'u': this.buf.paste(); break;
        case 'z': if (!this.buf.undo()) this.message = 'nothing to undo'; break;
        case 'y': this.buf.moveUp(this.bodyRows); break;
        case 'v': this.buf.moveDown(this.bodyRows); break;
        case 'a': this.buf.col = 0; break;
        case 'e': this.buf.end(); break;
        case 'd': this.buf.deleteChar(); break;
        case 't': this.runPython(); break;
        case 'l': this.output.write('\x1b[2J'); break;
        case 'c': this.message = `line ${this.buf.row + 1}, col ${this.buf.col + 1}`; break;
        case 'w':
          this.askPrompt('Search: ', this.searchTerm, (v) => this.doSearch(v));
          break;
        case '_':
          this.askPrompt('Go to line: ', '', (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) this.buf.gotoLine(n);
            else this.message = 'not a line number';
          });
          break;
        default: break;
      }
      this.buf.lastWasCut = wasCut;
      return;
    }

    if (key.meta) {
      if (key.name === 'u') this.buf.undo();
      else if (key.name === 'e') this.buf.redo();
      else if (key.name === '3') this.buf.toggleComment();
      else if (key.name === 'n') this.showNumbers = !this.showNumbers;
      else if (key.name === 'w') this.doSearch(this.searchTerm);
      this.buf.lastWasCut = false;
      return;
    }

    switch (key.name) {
      case 'return': this.buf.newline(); break;
      case 'backspace': this.buf.backspace(); break;
      case 'delete': this.buf.deleteChar(); break;
      case 'left': this.buf.moveLeft(); break;
      case 'right': this.buf.moveRight(); break;
      case 'up': this.buf.moveUp(); break;
      case 'down': this.buf.moveDown(); break;
      case 'home': this.buf.home(); break;
      case 'end': this.buf.end(); break;
      case 'pageup': this.buf.moveUp(this.bodyRows); break;
      case 'pagedown': this.buf.moveDown(this.bodyRows); break;
      case 'tab': if (key.shift) this.buf.dedent(); else this.buf.insert(INDENT); break;
      case 'escape': break;
      default:
        if (key.printable) this.buf.insert(key.str);
        break;
    }
    this.buf.lastWasCut = false;
  }

  loop() {
    const reader = new KeyReader(0);
    while (!this.done) {
      this.render();
      this.handleKey(reader.next());
    }
    return this.status;
  }
}

const HELP_TEXT_LINES = `
 pyedit — a nano-style editor for Python, built into maxshell

 Writing
   Tab / Shift-Tab    indent / dedent by four spaces
   Enter              keeps the current indent, and adds one after ':' or '(['
   Backspace          removes a whole indent stop inside leading whitespace
   M-3                toggle '#' comment on the current line

 Files
   ^O                 write the buffer out (asks for a name)
   ^X                 exit, offering to save first
   On saving a .py file the buffer is parsed with python3 and any syntax
   error is reported in the status line.

 Running
   ^T                 run the current buffer with python3 and show the output
                      (the buffer is piped to python, so it need not be saved)

 Moving
   arrows, PgUp/PgDn  move around          ^A / ^E   start / end of line
   ^Y / ^V            page up / down       ^_        go to line
   ^W                 search               M-W       search again

 Editing
   ^K                 cut the line (repeat to cut a run of lines)
   ^U                 paste what was cut
   ^Z or M-U          undo                 M-E       redo
   ^D                 delete the character under the cursor

 Display
   M-N                toggle line numbers
   ^C                 report the cursor position
   ^L                 redraw the screen
`.split('\n');

function runEditor(args, io, shell) {
  const files = args.filter((a) => !a.startsWith('-'));
  const filename = files[0] || '';

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    shell.writeTo(io.stderr, 'pyedit: needs an interactive terminal\n');
    return 1;
  }

  let text = '';
  if (filename) {
    const target = shell.resolve(filename);
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        shell.writeTo(io.stderr, `pyedit: cannot read ${filename}: ${e.code}\n`);
        return 1;
      }
    }
  }

  const editor = new PyEditor({ shell, io, filename, text });
  const wasRaw = process.stdin.isRaw;

  try {
    process.stdin.setRawMode(true);
    process.stdout.write('\x1b[?1049h\x1b[?25h');
    return editor.loop();
  } finally {
    process.stdout.write('\x1b[?1049l');
    try { process.stdin.setRawMode(!!wasRaw); } catch { /* not a tty any more */ }
  }
}

module.exports = { EditorBuffer, PyEditor, runEditor, TAB_WIDTH };
