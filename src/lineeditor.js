'use strict';

const readline = require('readline');

const ansi = require('./ansi');
const { commonPrefix } = require('./complete');

// A small line editor: live syntax highlighting, fish-style ghost suggestions
// from history, inline completion, and a right-hand prompt. Terminal I/O is
// injectable so the editing logic can be tested without a tty.
class LineEditor {
  constructor({ input, output, shell, highlight, complete, history }) {
    this.input = input;
    this.output = output;
    this.shell = shell;
    this.highlightFn = highlight || ((s) => s);
    this.completeFn = complete;
    this.history = history || [];
    this.attached = false;
  }

  get columns() {
    return this.output.columns || 80;
  }

  attach() {
    if (this.attached) return;
    try { readline.emitKeypressEvents(this.input); } catch { /* not a real stream */ }
    this.attached = true;
  }

  read(prompt, rprompt) {
    this.attach();
    this.prompt = prompt || '';
    this.rprompt = rprompt || '';
    this.buf = '';
    this.cursor = 0;
    this.histIdx = this.history.length;
    this.stash = '';
    this.suggestion = '';
    this.cursorRowPos = 0;
    this.lastEndRow = 0;

    return new Promise((resolve) => {
      this.resolve = resolve;
      this.onKey = (str, key) => {
        try {
          this.handleKey(str, key || {});
        } catch {
          this.finish({ line: '', aborted: true });
        }
      };
      if (this.input.setRawMode) this.input.setRawMode(true);
      this.input.on('keypress', this.onKey);
      if (this.input.resume) this.input.resume();
      this.render();
    });
  }

  finish(result) {
    this.input.removeListener('keypress', this.onKey);
    if (this.input.setRawMode) this.input.setRawMode(false);
    if (this.input.pause) this.input.pause();
    this.moveToEnd();
    this.output.write('\n');
    this.resolve(result);
  }

  moveToEnd() {
    const down = this.lastEndRow - this.cursorRowPos;
    let s = '';
    if (down > 0) s += `\x1b[${down}B`;
    s += '\r';
    this.output.write(s);
    this.cursorRowPos = this.lastEndRow;
  }

  // --- editing primitives ---------------------------------------------------

  insert(text) {
    this.buf = this.buf.slice(0, this.cursor) + text + this.buf.slice(this.cursor);
    this.cursor += text.length;
  }

  deleteBack() {
    if (!this.cursor) return;
    this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
    this.cursor--;
  }

  deleteForward() {
    if (this.cursor >= this.buf.length) return;
    this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
  }

  wordStart() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buf[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buf[i - 1])) i--;
    return i;
  }

  wordEnd() {
    let i = this.cursor;
    while (i < this.buf.length && /\s/.test(this.buf[i])) i++;
    while (i < this.buf.length && !/\s/.test(this.buf[i])) i++;
    return i;
  }

  deleteWordBack() {
    const start = this.wordStart();
    this.buf = this.buf.slice(0, start) + this.buf.slice(this.cursor);
    this.cursor = start;
  }

  acceptSuggestion() {
    if (!this.suggestion) return false;
    this.buf = this.suggestion;
    this.cursor = this.buf.length;
    this.suggestion = '';
    return true;
  }

  // Right-arrow at end of line accepts the ghost suggestion, like fish.
  forwardOrAccept() {
    if (this.cursor >= this.buf.length) {
      if (this.acceptSuggestion()) return;
      return;
    }
    this.cursor++;
  }

  updateSuggestion() {
    this.suggestion = '';
    if (!this.buf || this.cursor !== this.buf.length) return;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (entry.length > this.buf.length && entry.startsWith(this.buf) && !entry.includes('\n')) {
        this.suggestion = entry;
        return;
      }
    }
  }

  historyPrev() {
    if (!this.history.length) return;
    if (this.histIdx === this.history.length) this.stash = this.buf;
    let i = this.histIdx - 1;
    while (i >= 0 && this.history[i] === this.buf) i--;
    if (i < 0) return;
    this.histIdx = i;
    this.buf = this.history[i];
    this.cursor = this.buf.length;
  }

  historyNext() {
    if (this.histIdx >= this.history.length) return;
    const i = this.histIdx + 1;
    this.histIdx = i;
    this.buf = i >= this.history.length ? this.stash : this.history[i];
    this.cursor = this.buf.length;
  }

  complete() {
    if (!this.completeFn) return;
    const { items, partial } = this.completeFn(this.buf, this.cursor, this.shell);
    if (!items.length) return;

    let insertion;
    if (items.length === 1) {
      insertion = items[0].endsWith('/') ? items[0] : `${items[0]} `;
    } else {
      const shared = commonPrefix(items);
      if (shared.length > partial.length) insertion = shared;
      else { this.showList(items); return; }
    }

    const start = this.cursor - partial.length;
    this.buf = this.buf.slice(0, start) + insertion + this.buf.slice(this.cursor);
    this.cursor = start + insertion.length;
  }

  showList(items) {
    this.moveToEnd();
    const shown = items.slice(0, 120);
    const colWidth = Math.max(...shown.map((s) => s.length)) + 2;
    const perRow = Math.max(1, Math.floor(this.columns / colWidth));

    let s = '\n';
    shown.forEach((item, i) => {
      s += item.padEnd(colWidth);
      if ((i + 1) % perRow === 0) s += '\n';
    });
    if (shown.length % perRow !== 0) s += '\n';
    if (items.length > shown.length) s += `${ansi.dim()}… ${items.length - shown.length} more${ansi.reset()}\n`;

    this.output.write(s);
    this.cursorRowPos = 0;
    this.lastEndRow = 0;
  }

  // --- key handling ---------------------------------------------------------

  handleKey(str, key) {
    const name = key.name;

    if (key.ctrl) {
      switch (name) {
        case 'c':
          this.output.write(`${ansi.fg('gray')}^C${ansi.reset()}`);
          return this.finish({ line: '', aborted: true });
        case 'd':
          if (!this.buf) return this.finish({ line: '', eof: true });
          this.deleteForward();
          break;
        case 'a': this.cursor = 0; break;
        case 'e':
          if (!this.acceptSuggestion()) this.cursor = this.buf.length;
          else this.cursor = this.buf.length;
          break;
        case 'b': this.cursor = Math.max(0, this.cursor - 1); break;
        case 'f': this.forwardOrAccept(); break;
        case 'k': this.buf = this.buf.slice(0, this.cursor); break;
        case 'u': this.buf = this.buf.slice(this.cursor); this.cursor = 0; break;
        case 'w': this.deleteWordBack(); break;
        case 'p': this.historyPrev(); break;
        case 'n': this.historyNext(); break;
        case 'l':
          this.output.write('\x1b[2J\x1b[H');
          this.cursorRowPos = 0;
          this.lastEndRow = 0;
          break;
        default: break;
      }
      this.updateSuggestion();
      return this.render();
    }

    if (key.meta) {
      if (name === 'b') this.cursor = this.wordStart();
      else if (name === 'f') this.cursor = this.wordEnd();
      else if (name === 'd') {
        const end = this.wordEnd();
        this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(end);
      }
      this.updateSuggestion();
      return this.render();
    }

    switch (name) {
      case 'return': case 'enter':
        this.suggestion = '';
        this.render();
        return this.finish({ line: this.buf });
      case 'backspace': this.deleteBack(); break;
      case 'delete': this.deleteForward(); break;
      case 'left': this.cursor = Math.max(0, this.cursor - 1); break;
      case 'right': this.forwardOrAccept(); break;
      case 'home': this.cursor = 0; break;
      case 'end': this.acceptSuggestion(); this.cursor = this.buf.length; break;
      case 'up': this.historyPrev(); break;
      case 'down': this.historyNext(); break;
      case 'tab': this.complete(); break;
      case 'escape': break;
      default:
        if (str && str.length >= 1 && str.charCodeAt(0) >= 32 && str !== '\t') this.insert(str);
        break;
    }

    this.updateSuggestion();
    return this.render();
  }

  // --- rendering ------------------------------------------------------------

  render() {
    const cols = this.columns;
    let s = '';

    if (this.cursorRowPos > 0) s += `\x1b[${this.cursorRowPos}A`;
    s += '\r\x1b[J';

    const painted = this.highlightFn(this.buf, this.shell);
    const ghostText = this.suggestion ? this.suggestion.slice(this.buf.length) : '';
    const ghost = ghostText ? `${ansi.dim()}${ghostText}${ansi.reset()}` : '';

    const promptW = ansi.width(this.prompt);
    const totalW = promptW + [...this.buf].length + [...ghostText].length;
    const endRow = Math.floor(totalW / cols);

    if (this.rprompt) {
      const rw = ansi.width(this.rprompt);
      if (totalW + rw + 2 <= cols) s += `\x1b[${cols - rw + 1}G${this.rprompt}\r`;
    }

    s += this.prompt + painted + ghost;
    // Force the wrap deterministically when we land exactly on a boundary.
    if (totalW > 0 && totalW % cols === 0) s += '\n';

    const cursorCell = promptW + [...this.buf.slice(0, this.cursor)].length;
    const cursorRow = Math.floor(cursorCell / cols);
    const cursorCol = cursorCell % cols;

    if (endRow > 0) s += `\x1b[${endRow}A`;
    s += '\r';
    if (cursorRow > 0) s += `\x1b[${cursorRow}B`;
    if (cursorCol > 0) s += `\x1b[${cursorCol}C`;

    this.cursorRowPos = cursorRow;
    this.lastEndRow = endRow;
    this.output.write(s);
  }
}

module.exports = { LineEditor };
