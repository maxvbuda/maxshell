'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const { KeyReader } = require('./keys');
const { computeStates, renderSlice, detectLanguage, languageById } = require('./syntax');
const { fullscreen, requireTty } = require('./tui');
const { findInPath } = require('./builtins');

const TAB_WIDTH = 4;
const INDENT = ' '.repeat(TAB_WIDTH);
const UNDO_LIMIT = 300;
const DISK_POLL_MS = 400;

// Cheap fingerprint of a file, used to notice writes by other programs.
function statSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

// --- the document model (pure, so it can be tested without a terminal) ------

class EditorBuffer {
  constructor(text = '', { lang } = {}) {
    this.lang = lang || languageById('python');
    this.lines = text.length ? text.split('\n') : [''];
    if (!this.lines.length) this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.modified = false;
    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = { text: '', linewise: true };
    this.lastWasCut = false;
    this.mark = null;
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
    this.mark = null;
    const l = this.line;
    this.lines[this.row] = l.slice(0, this.col) + text + l.slice(this.col);
    this.col += text.length;
    this.modified = true;
  }

  // Code with any trailing line comment removed, for indentation decisions.
  stripComment(text) {
    const marker = this.lang.comment;
    if (!marker) return text;
    const at = text.indexOf(marker);
    return at === -1 ? text : text.slice(0, at);
  }

  // Enter keeps the current indentation and adds a level where the language
  // opens a block — after ':' in Python, after '{' in JavaScript, after
  // 'then'/'do' in shell. Between a bracket pair it opens the pair up:
  // `f(|)` becomes three lines with the cursor indented in the middle.
  newline() {
    this.pushUndo();
    this.mark = null;
    const l = this.line;
    const before = l.slice(0, this.col);
    const after = l.slice(this.col);
    const base = /^[ \t]*/.exec(before)[0];
    let indent = base;
    const code = this.stripComment(before).trimEnd();
    if (this.lang.indentAfter && this.lang.indentAfter.test(code)) indent += INDENT;

    const PAIRS = { '(': ')', '[': ']', '{': '}' };
    const opener = before[before.length - 1];
    if (this.lang.pairs && PAIRS[opener] && after.trimStart().startsWith(PAIRS[opener])) {
      this.lines[this.row] = before;
      this.lines.splice(this.row + 1, 0, indent, base + after.trimStart());
      this.row++;
      this.col = indent.length;
      this.modified = true;
      return;
    }

    this.lines[this.row] = before;
    this.lines.splice(this.row + 1, 0, indent + after);
    this.row++;
    this.col = indent.length;
    this.modified = true;
  }

  // Types one character. A closing bracket typed into leading whitespace
  // steps back one indent level, so `}` lines up with the line that opened.
  typeChar(ch) {
    const before = this.line.slice(0, this.col);
    if (this.lang.closers.includes(ch) && /^ +$/.test(before) && before.length >= TAB_WIDTH) {
      this.pushUndo();
      this.lines[this.row] = before.slice(TAB_WIDTH) + this.line.slice(this.col);
      this.col -= TAB_WIDTH;
      const l = this.line;
      this.lines[this.row] = l.slice(0, this.col) + ch + l.slice(this.col);
      this.col += 1;
      this.mark = null;
      this.modified = true;
      return;
    }
    this.insert(ch);
  }

  backspace() {
    if (this.deleteSelection()) return;
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
    if (this.deleteSelection()) return;
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

  // --- selection ------------------------------------------------------------

  setMark() { this.mark = { row: this.row, col: this.col }; }

  clearMark() { this.mark = null; }

  toggleMark() {
    if (this.mark) this.mark = null;
    else this.setMark();
    return !!this.mark;
  }

  // The marked region, ordered start-before-end, or null when nothing is
  // selected.
  selectionRange() {
    if (!this.mark) return null;
    const a = this.mark;
    const b = { row: this.row, col: this.col };
    if (a.row === b.row && a.col === b.col) return null;
    const aFirst = a.row < b.row || (a.row === b.row && a.col < b.col);
    return {
      start: { ...(aFirst ? a : b) },
      end: { ...(aFirst ? b : a) },
    };
  }

  selectedText() {
    const range = this.selectionRange();
    if (!range) return '';
    const { start, end } = range;
    if (start.row === end.row) return this.lines[start.row].slice(start.col, end.col);
    const parts = [this.lines[start.row].slice(start.col)];
    for (let r = start.row + 1; r < end.row; r++) parts.push(this.lines[r]);
    parts.push(this.lines[end.row].slice(0, end.col));
    return parts.join('\n');
  }

  deleteSelection() {
    const range = this.selectionRange();
    if (!range) return false;
    this.pushUndo();
    const { start, end } = range;
    const head = this.lines[start.row].slice(0, start.col);
    const tail = this.lines[end.row].slice(end.col);
    this.lines.splice(start.row, end.row - start.row + 1, head + tail);
    this.row = start.row;
    this.col = start.col;
    this.mark = null;
    this.modified = true;
    return true;
  }

  // Rows the next block operation should touch.
  activeRows() {
    const range = this.selectionRange();
    return range ? [range.start.row, range.end.row] : [this.row, this.row];
  }

  // --- indentation and comments ---------------------------------------------

  indent() {
    const [from, to] = this.activeRows();
    this.pushUndo();
    for (let r = from; r <= to; r++) {
      if (from !== to && !this.lines[r].trim()) continue;
      this.lines[r] = INDENT + this.lines[r];
    }
    this.col += TAB_WIDTH;
    if (this.mark && this.mark.row >= from && this.mark.row <= to) this.mark.col += TAB_WIDTH;
    this.modified = true;
    this.clamp();
  }

  dedent() {
    const [from, to] = this.activeRows();
    let touched = false;
    let atCursor = 0;
    let atMark = 0;
    this.pushUndo();
    for (let r = from; r <= to; r++) {
      const m = /^[ ]{1,4}/.exec(this.lines[r]);
      if (!m) continue;
      this.lines[r] = this.lines[r].slice(m[0].length);
      touched = true;
      if (r === this.row) atCursor = m[0].length;
      if (this.mark && r === this.mark.row) atMark = m[0].length;
    }
    if (!touched) { this.undoStack.pop(); return; }
    this.col = Math.max(0, this.col - atCursor);
    if (this.mark) this.mark.col = Math.max(0, this.mark.col - atMark);
    this.modified = true;
    this.clamp();
  }

  // Comments the block, or uncomments it when every line is already commented.
  toggleComment() {
    const [from, to] = this.activeRows();
    const rows = [];
    for (let r = from; r <= to; r++) if (this.lines[r].trim()) rows.push(r);
    if (!rows.length) rows.push(this.row);

    const marker = this.lang.comment;
    if (!marker) return false;
    const esc = marker.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const isCommented = new RegExp(`^\\s*${esc}`);
    const parts = new RegExp(`^(\\s*)(${esc} ?)?(.*)$`);

    this.pushUndo();
    const allCommented = rows.every((r) => isCommented.test(this.lines[r]));
    for (const r of rows) {
      const m = parts.exec(this.lines[r]);
      if (allCommented) {
        if (m[2]) this.lines[r] = m[1] + m[3];
      } else if (!m[2]) {
        this.lines[r] = `${m[1]}${marker} ${m[3]}`;
      }
    }
    this.modified = true;
    this.clamp();
  }

  // --- clipboard ------------------------------------------------------------

  copy() {
    const text = this.selectedText();
    this.clipboard = text
      ? { text, linewise: false }
      : { text: this.lines[this.row], linewise: true };
    return this.clipboard;
  }

  cutLine() {
    if (this.selectionRange()) {
      this.clipboard = { text: this.selectedText(), linewise: false };
      this.deleteSelection();
      return;
    }
    this.pushUndo();
    const text = this.lines[this.row];
    this.clipboard = this.lastWasCut && this.clipboard.linewise
      ? { text: `${this.clipboard.text}\n${text}`, linewise: true }
      : { text, linewise: true };
    this.lines.splice(this.row, 1);
    if (!this.lines.length) this.lines = [''];
    this.row = Math.min(this.row, this.lines.length - 1);
    this.col = 0;
    this.modified = true;
  }

  paste() {
    if (!this.clipboard || !this.clipboard.text) return;
    this.pushUndo();
    this.mark = null;
    if (this.clipboard.linewise) {
      const lines = this.clipboard.text.split('\n');
      this.lines.splice(this.row, 0, ...lines);
      this.row = Math.min(this.row + lines.length, this.lines.length - 1);
      this.col = 0;
    } else {
      this.insertMultiline(this.clipboard.text);
    }
    this.modified = true;
  }

  // Inserts text that may span lines. Callers push their own undo entry.
  insertMultiline(text) {
    const parts = text.split('\n');
    const before = this.line.slice(0, this.col);
    const after = this.line.slice(this.col);
    if (parts.length === 1) {
      this.lines[this.row] = before + parts[0] + after;
      this.col += parts[0].length;
      return;
    }
    const last = parts[parts.length - 1];
    const block = [before + parts[0], ...parts.slice(1, -1), last + after];
    this.lines.splice(this.row, 1, ...block);
    this.row += parts.length - 1;
    this.col = last.length;
  }

  // --- brackets -------------------------------------------------------------

  // The partner of the bracket at (row, col), searching outward. Returns null
  // when the character is not a bracket or the pair is unbalanced.
  findMatch(row, col) {
    const OPEN = '([{';
    const CLOSE = ')]}';
    const ch = (this.lines[row] || '')[col];
    const oi = OPEN.indexOf(ch);
    const ci = CLOSE.indexOf(ch);
    if (oi === -1 && ci === -1) return null;

    if (oi !== -1) {
      const want = CLOSE[oi];
      let depth = 0;
      for (let r = row; r < this.lines.length; r++) {
        const line = this.lines[r];
        for (let c = r === row ? col : 0; c < line.length; c++) {
          if (line[c] === ch) depth++;
          else if (line[c] === want && --depth === 0) return { row: r, col: c };
        }
      }
      return null;
    }

    const want = OPEN[ci];
    let depth = 0;
    for (let r = row; r >= 0; r--) {
      const line = this.lines[r];
      for (let c = r === row ? col : line.length - 1; c >= 0; c--) {
        if (line[c] === ch) depth++;
        else if (line[c] === want && --depth === 0) return { row: r, col: c };
      }
    }
    return null;
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
  [['^O', 'Save'], ['^X', 'Exit'], ['^W', 'Find'], ['^T', 'Run'], ['^G', 'Help'], ['M-A', 'Mark']],
  [['^K', 'Cut'], ['M-6', 'Copy'], ['^U', 'Paste'], ['Tab', 'Indent'], ['M-3', 'Comment'], ['^R', 'Reload']],
];

class PyEditor {
  constructor({ shell, io, filename, text, input, output, lang, tool = 'edit' }) {
    this.shell = shell;
    this.io = io;
    this.input = input || process.stdin;
    this.output = output || process.stdout;
    this.filename = filename || '';
    this.lang = lang || detectLanguage(filename, (text || '').split('\n', 1)[0]);
    this.tool = tool;
    this.buf = new EditorBuffer(text || '', { lang: this.lang });
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
    this.diskSig = null;
    this.diskChanged = false;
    this.lastCheck = 0;
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

  // Multi-line construct state, recomputed only when the text changes. Keyed on
  // the text itself: a length-based key misses same-length edits.
  syntaxState() {
    const text = this.buf.text;
    if (text !== this.stateVersion) {
      this.states = computeStates(this.lang, this.buf.lines);
      this.stateVersion = text;
    }
    return this.states;
  }

  // --- rendering ------------------------------------------------------------

  bar(text) {
    return require('./tui').bar(text, this.cols);
  }

  titleBar() {
    const name = this.filename || 'new buffer';
    const flag = `${this.diskChanged ? '  Changed on disk' : ''}${this.buf.modified ? '  Modified' : ''}`;
    const left = `  maxshell ${this.tool}  ${name}  [${this.lang.name}]`;
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

  // The bracket under (or just before) the cursor, with its partner.
  bracketHighlight() {
    for (const probe of [this.buf.col, this.buf.col - 1]) {
      if (probe < 0) continue;
      const partner = this.buf.findMatch(this.buf.row, probe);
      if (partner) return [{ row: this.buf.row, col: probe }, partner];
    }
    return null;
  }

  // Column ranges on this row to show in reverse video.
  rowRanges(row) {
    const ranges = [];
    const sel = this.buf.selectionRange();
    if (sel && row >= sel.start.row && row <= sel.end.row) {
      const from = row === sel.start.row ? sel.start.col : 0;
      // Past the end of a fully selected row, so the newline reads as selected.
      const to = row === sel.end.row ? sel.end.col : this.buf.lines[row].length + 1;
      ranges.push([from, to]);
    }
    if (this.bracketPair) {
      for (const point of this.bracketPair) {
        if (point.row === row) ranges.push([point.col, point.col + 1]);
      }
    }
    return ranges;
  }

  render() {
    if (this.mode === 'help') return this.renderPager(`${this.tool} help`, HELP_TEXT_LINES);
    if (this.mode === 'output') return this.renderPager('output — any key returns', this.view || []);

    this.scroll();
    this.bracketPair = this.bracketHighlight();
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
      s += renderSlice(
        this.lang, this.buf.lines[row], states[row] || null,
        this.leftCol, this.leftCol + width, this.rowRanges(row),
      );
      s += '\x1b[K';
    }

    s += '\r\n';
    if (this.mode === 'prompt') {
      s += this.bar(` ${this.prompt.label}${this.prompt.value}`);
    } else {
      const sel = this.buf.selectionRange();
      const selected = sel
        ? `  ${sel.end.row - sel.start.row + 1} line${sel.end.row === sel.start.row ? '' : 's'} selected`
        : (this.buf.mark ? '  mark set' : '');
      const pos = `line ${this.buf.row + 1}/${this.buf.lines.length}  col ${this.buf.col + 1}${selected}`;
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

  // Re-reads the file when another program has written it. Returns true when
  // anything changed, so the caller knows to redraw.
  checkDisk(force = false) {
    if (!this.filename) return false;
    const now = Date.now();
    if (!force && now - this.lastCheck < DISK_POLL_MS) return false;
    this.lastCheck = now;

    const sig = statSig(this.shell.resolve(this.filename));
    if (sig === this.diskSig) return false;
    this.diskSig = sig;

    if (sig === null) {
      this.message = 'file is no longer on disk — ^O writes it back';
      return true;
    }
    if (!this.buf.modified) {
      this.loadFromDisk();
      this.message = 'reloaded — the file changed on disk';
      this.diskChanged = false;
      return true;
    }
    // Both copies have moved on; let the user choose rather than guessing.
    this.diskChanged = true;
    this.message = 'changed on disk — ^R reloads, ^O overwrites';
    return true;
  }

  loadFromDisk() {
    const file = this.shell.resolve(this.filename);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      this.message = `cannot read ${this.filename}: ${e.code || e.message}`;
      return false;
    }
    const { row, col } = this.buf;
    this.buf.pushUndo();
    this.buf.lines = text.length ? text.split('\n') : [''];
    this.buf.row = Math.min(row, this.buf.lines.length - 1);
    this.buf.col = col;
    this.buf.clamp();
    this.buf.modified = false;
    this.stateVersion = -1;
    this.diskSig = statSig(file);
    return true;
  }

  tryReload() {
    if (!this.filename) { this.message = 'no file to reload'; return; }
    if (!this.buf.modified) {
      if (this.loadFromDisk()) this.message = 'reloaded from disk';
      this.diskChanged = false;
      return;
    }
    this.askPrompt('Discard your edits and reload? (y/n) ', '', (value) => {
      const answer = value.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        if (this.loadFromDisk()) this.message = 'reloaded from disk';
        this.diskChanged = false;
      } else {
        this.message = 'kept your version';
      }
    });
  }

  save(name) {
    const target = name || this.filename;
    if (!target) { this.askPrompt('File name to write: ', '', (v) => this.save(v)); return; }

    this.checkDisk(true);
    if (this.diskChanged && target === this.filename) {
      this.diskChanged = false;
      this.askPrompt('It changed on disk since you opened it. Overwrite? (y/n) ', '', (value) => {
        const answer = value.trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') this.writeOut(target);
        else this.message = 'not saved — ^R reloads the version on disk';
      });
      return;
    }
    this.writeOut(target);
  }

  writeOut(target) {
    const file = this.shell.resolve(target);
    try {
      fs.writeFileSync(file, this.buf.text);
    } catch (e) {
      this.message = `cannot write ${target}: ${e.code || e.message}`;
      return;
    }
    this.filename = target;
    this.buf.modified = false;
    this.diskChanged = false;
    this.diskSig = statSig(file);
    this.lastCheck = Date.now();
    const lines = this.buf.lines.length;
    const problem = this.checkSyntax(file);
    this.message = problem
      ? `wrote ${lines} lines — ${problem}`
      : `wrote ${lines} lines`;
  }

  // The first syntax error in the buffer, or null. Uses each language's own
  // parser: python's ast, node --check, JSON.parse, and maxshell's parser.
  checkSyntax(file) {
    const text = this.buf.text;
    switch (this.lang.check) {
      case 'python': {
        const py = this.pythonPath();
        if (!py) return null;
        const res = spawnSync(py, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
          input: text, encoding: 'utf8', timeout: 10000,
        });
        if (!res || res.error || res.status === 0) return null;
        const err = (res.stderr || '').trim().split('\n');
        const where = /line (\d+)/.exec(res.stderr || '');
        const detail = err[err.length - 1] || 'syntax error';
        return where ? `${detail} (line ${where[1]})` : detail;
      }
      case 'node': {
        if (!file) return null;
        const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
        if (!res || res.error || res.status === 0) return null;
        const lines = (res.stderr || '').split('\n');
        const where = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(res.stderr || '');
        const detail = lines.find((l) => /Error/.test(l)) || 'syntax error';
        return where ? `${detail.trim()} (line ${where[1]})` : detail.trim();
      }
      case 'json': {
        try {
          JSON.parse(text);
          return null;
        } catch (e) {
          const pos = /position (\d+)/.exec(e.message);
          const line = pos ? text.slice(0, Number(pos[1])).split('\n').length : null;
          const detail = e.message.replace(/^JSON\.parse: /, '');
          return line ? `${detail} (line ${line})` : detail;
        }
      }
      case 'c':
      case 'cpp': {
        const cc = this.compiler();
        if (!cc || !file) return null;
        const res = spawnSync(cc, ['-fsyntax-only', '-x', this.lang.check === 'c' ? 'c' : 'c++', file], {
          encoding: 'utf8', cwd: path.dirname(file), timeout: 30000,
        });
        if (!res || res.error || res.status === 0) return null;
        const first = /:(\d+):\d+: (?:fatal )?error: (.*)/.exec(ansi.strip(res.stderr || ''));
        return first ? `error: ${first[2]} (line ${first[1]})` : 'does not compile';
      }
      case 'maxshell': {
        try {
          const { Parser } = require('./parser');
          new Parser(text).parseProgram();
          return null;
        } catch (e) {
          return e.message;
        }
      }
      default:
        return null;
    }
  }

  // The C or C++ compiler on PATH, or null.
  compiler() {
    const names = this.lang.id === 'c' ? ['cc', 'clang', 'gcc'] : ['c++', 'clang++', 'g++'];
    for (const name of names) {
      const found = findInPath(name, this.shell);
      if (found) return found;
    }
    return null;
  }

  // C and C++ are compiled to a scratch binary, then run. Local #includes
  // still resolve because the file's own directory is on the include path.
  compileAndRun() {
    const cc = this.compiler();
    if (!cc) { this.message = `no ${this.lang.name} compiler found (need ${this.lang.id === 'c' ? 'cc' : 'c++'})`; return; }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxshell-run-'));
    const src = path.join(dir, this.lang.id === 'c' ? 'main.c' : 'main.cpp');
    const bin = path.join(dir, 'main');
    const includeDir = this.filename ? path.dirname(this.shell.resolve(this.filename)) : this.shell.cwd;
    const lines = [];

    try {
      fs.writeFileSync(src, this.buf.text);
      const build = spawnSync(cc, [src, '-o', bin, '-I', includeDir], {
        encoding: 'utf8', cwd: dir, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      });
      if (build.error || build.status !== 0) {
        const errs = ansi.strip(`${build.stderr || ''}${build.stdout || ''}`).split(src).join(this.filename || 'buffer');
        lines.push(`$ ${path.basename(cc)} ${this.filename || '-'}   (compile failed)`, '', ...errs.split('\n'));
      } else {
        const run = spawnSync(bin, [], {
          input: '', encoding: 'utf8', cwd: this.shell.cwd, env: this.shell.env,
          timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        });
        const why = run.error && run.error.code === 'ETIMEDOUT' ? 'timed out after 30s'
          : run.signal ? `killed by ${run.signal}` : `exit ${run.status ?? '?'}`;
        const warnings = ansi.strip(build.stderr || '').trim();
        lines.push(`$ ${path.basename(cc)} ${this.filename || '-'} && ./main   (${why})`, '');
        if (warnings) lines.push(...warnings.split(src).join(this.filename || 'buffer').split('\n'), '');
        lines.push(...ansi.strip(`${run.stdout || ''}${run.stderr || ''}`).split('\n'));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    this.view = lines;
    this.viewTop = 0;
    this.mode = 'output';
  }

  // What ^T runs the buffer with: [command, args], or null.
  runner() {
    switch (this.lang.run) {
      case 'python': {
        const py = this.pythonPath();
        return py ? [py, ['-']] : null;
      }
      case 'node': return [process.execPath, ['-']];
      case 'maxshell': return [process.execPath, [path.join(__dirname, '..', 'bin', 'maxshell.js')]];
      default: return null;
    }
  }

  runBuffer() {
    if (!this.lang.run) { this.message = `nothing to run for ${this.lang.name}`; return; }
    if (this.lang.run === 'c' || this.lang.run === 'cpp') { this.compileAndRun(); return; }
    const cmd = this.runner();
    if (!cmd) { this.message = `no interpreter found for ${this.lang.name}`; return; }
    const res = spawnSync(cmd[0], cmd[1], {
      input: this.buf.text,
      encoding: 'utf8',
      cwd: this.shell.cwd,
      env: this.shell.env,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Programs may colour their output (FORCE_COLOR etc.); the output pager
    // slices lines by character, which would cut escape sequences in half.
    const out = ansi.strip(`${res.stdout || ''}${res.stderr || ''}`);
    const header = `$ ${path.basename(cmd[0])} ${this.filename || '-'}   (exit ${res.status ?? '?'})`;
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
        case 't': this.runBuffer(); break;
        case 'r': this.tryReload(); break;
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
      else if (key.name === '3') {
        if (this.buf.toggleComment() === false) this.message = `${this.lang.name} has no line comments`;
      }
      else if (key.name === 'n') this.showNumbers = !this.showNumbers;
      else if (key.name === 'w') this.doSearch(this.searchTerm);
      else if (key.name === 'a') {
        this.message = this.buf.toggleMark() ? 'mark set — move to select' : 'mark cleared';
      } else if (key.name === '6') {
        const { linewise } = this.buf.copy();
        this.message = linewise ? 'copied the line' : 'copied the selection';
      }
      this.buf.lastWasCut = false;
      return;
    }

    // Shift with a movement key starts a selection if one isn't open.
    const MOVES = ['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown'];
    if (key.shift && MOVES.includes(key.name) && !this.buf.mark) this.buf.setMark();

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
      case 'tab':
        // With a selection Tab shifts the whole block; without one it just
        // types an indent at the cursor.
        if (key.shift) this.buf.dedent();
        else if (this.buf.selectionRange()) this.buf.indent();
        else this.buf.insert(INDENT);
        break;
      case 'escape':
        if (this.buf.mark) { this.buf.clearMark(); this.message = 'mark cleared'; }
        break;
      default:
        if (key.printable) this.buf.typeChar(key.str);
        break;
    }
    this.buf.lastWasCut = false;
  }

  loop() {
    const reader = new KeyReader(0);
    this.render();
    while (!this.done) {
      const key = reader.next(DISK_POLL_MS);
      if (key.name === 'timeout') {
        // Idle: only redraw if the file moved underneath us.
        if (this.checkDisk()) this.render();
        continue;
      }
      this.checkDisk();
      this.handleKey(key);
      if (!this.done) this.render();
    }
    return this.status;
  }
}

const HELP_TEXT_LINES = `
 edit — a nano-style editor built into maxshell (pyedit opens it in Python mode)

 Languages: Python, JavaScript, C, C++, shell, JSON, Markdown — picked from the
 file extension or #! line. Force one with  edit --lang=cpp file

 Writing
   Tab / Shift-Tab    indent / dedent by four spaces
   Enter              keeps the indent, adds one where a block opens (':' in
                      Python, '{' in JS, then/do in shell), and splits f(|)
   }  ]  )            typed at the start of a line, steps back a level
   Backspace          removes a whole indent stop inside leading whitespace
   M-3                toggle a line comment (# or //) on the line or selection

 Selecting
   M-A                set or clear the mark, then move to select
   shift-arrows       select without setting the mark first
   Escape             clear the mark
   Tab / Shift-Tab    with a selection, indent or dedent every line in it
   M-6                copy          ^K  cut          ^U  paste
   Matching brackets around the cursor are highlighted as you move.

 Files
   ^O                 write the buffer out (asks for a name)
   ^X                 exit, offering to save first
   ^R                 re-read the file from disk (asks first if you have edits)

 If another program writes the file while it is open, the editor notices within
 half a second. An untouched buffer is reloaded for you; if you have your own
 unsaved edits it says so instead, and ^O will ask before overwriting.
   On saving, the file is checked with its language's own parser (python's
   ast, node --check, JSON.parse, maxshell's parser) and the first error is
   reported in the status line.

 Running
   ^T                 run the buffer (python3, node, maxshell, or compile C/C++
                      and run the binary) and show the
                      output — it is piped in, so it need not be saved

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

const LANG_ALIASES = {
  py: 'python', python: 'python', js: 'javascript', javascript: 'javascript', node: 'javascript',
  sh: 'shell', shell: 'shell', bash: 'shell', zsh: 'shell', json: 'json',
  md: 'markdown', markdown: 'markdown', txt: 'plain', text: 'plain', plain: 'plain',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', c: 'c',
};

function readForEditing(filename, shell) {
  if (!filename) return { text: '' };
  try {
    return { text: fs.readFileSync(shell.resolve(filename), 'utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') return { text: '' };
    return { error: e.code || e.message };
  }
}

// Runs an editor inside a screen that is already full-screen and raw. Used by
// `files` to open a file without leaving its own session.
function openEditor(shell, io, filename, { lang, tool = 'edit' } = {}) {
  const { text, error } = readForEditing(filename, shell);
  if (error) return { status: 1, error };
  const editor = new PyEditor({ shell, io, filename, text, lang, tool });
  if (filename) editor.diskSig = statSig(shell.resolve(filename));
  return { status: editor.loop() };
}

// The `edit` and `pyedit` builtins.
function runEditor(args, io, shell, { tool = 'edit', lang: forced } = {}) {
  let lang = forced ? languageById(forced) : null;
  const files = [];
  for (const a of args) {
    const m = /^--lang=(.+)$/.exec(a);
    if (m) {
      const id = LANG_ALIASES[m[1].toLowerCase()];
      if (!id) {
        shell.writeTo(io.stderr, `${tool}: unknown language '${m[1]}' (try py, js, sh, cpp, c, json, md)\n`);
        return 2;
      }
      lang = languageById(id);
    } else if (!a.startsWith('-')) {
      files.push(a);
    }
  }
  const filename = files[0] || '';

  if (!requireTty(tool, io, shell)) return 1;

  const { error } = readForEditing(filename, shell);
  if (error) {
    shell.writeTo(io.stderr, `${tool}: cannot read ${filename}: ${error}\n`);
    return 1;
  }

  return fullscreen(() => openEditor(shell, io, filename, { lang, tool }).status);
}

module.exports = { EditorBuffer, PyEditor, runEditor, openEditor, TAB_WIDTH, LANG_ALIASES };
