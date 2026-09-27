'use strict';

const readline = require('readline');

const ansi = require('./ansi');
const { commonPrefix } = require('./complete');

// A small line editor: live syntax highlighting, fish-style ghost suggestions
// from history, inline completion, and a right-hand prompt. Terminal I/O is
// injectable so the editing logic can be tested without a tty.
const PAIRS = { '"': '"', "'": "'", '`': '`', '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(['"', "'", '`', ')', ']', '}']);

class LineEditor {
  constructor({ input, output, shell, highlight, complete, history, searchHistory }) {
    this.input = input;
    this.output = output;
    this.shell = shell;
    this.highlightFn = highlight || ((s) => s);
    this.completeFn = complete;
    this.history = history || [];
    this.searchHistory = searchHistory || null;
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

  // `fix` is a corrected command offered after a typo: shown dimmed while the
  // line is empty, and run by pressing Enter.
  read(prompt, rprompt, { fix = null } = {}) {
    this.attach();
    this.fix = fix;
    this.search = null;
    this.menu = null;
    this.prompt = prompt || '';
    this.rprompt = rprompt || '';
    this.buf = '';
    this.cursor = 0;
    this.histIdx = this.history.length;
    this.stash = '';
    this.suggestion = '';
    this.cursorRowPos = 0;
    this.lastEndRow = 0;
    this.undo = [];
    this.lastKind = null;
    this.pasting = false;
    this.lastArgIdx = null;

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
      // Bracketed paste: a pasted block arrives marked, so its newlines are
      // inserted rather than run one by one.
      if (this.input.isTTY) this.output.write('\x1b[?2004h');
      this.render();
    });
  }

  finish(result) {
    if (this.input.isTTY) this.output.write('\x1b[?2004l');
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
  // Positions are UTF-16 offsets, but the cursor always moves by whole code
  // points so an emoji is never split in half.

  prevPos(i = this.cursor) {
    if (i <= 0) return 0;
    const c = this.buf.charCodeAt(i - 1);
    return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  }

  nextPos(i = this.cursor) {
    if (i >= this.buf.length) return this.buf.length;
    const c = this.buf.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff && i + 1 < this.buf.length ? i + 2 : i + 1;
  }

  // Remembers the line before a change so ^_ can undo it. A run of typing
  // is undone as one step.
  saveUndo(kind) {
    if (kind === 'type' && this.lastKind === 'type') return;
    this.lastKind = kind;
    const top = this.undo[this.undo.length - 1];
    if (top && top.buf === this.buf && top.cursor === this.cursor) return;
    this.undo.push({ buf: this.buf, cursor: this.cursor });
    if (this.undo.length > 200) this.undo.shift();
  }

  undoEdit() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.buf = prev.buf;
    this.cursor = prev.cursor;
    this.lastKind = null;
  }

  kill(from, to) {
    if (to <= from) return;
    this.saveUndo('kill');
    LineEditor.killed = this.buf.slice(from, to);
    this.buf = this.buf.slice(0, from) + this.buf.slice(to);
    this.cursor = from;
  }

  yank() {
    if (!LineEditor.killed) return;
    this.saveUndo('yank');
    this.insert(LineEditor.killed);
  }

  insert(text) {
    this.buf = this.buf.slice(0, this.cursor) + text + this.buf.slice(this.cursor);
    this.cursor += text.length;
  }

  deleteBack() {
    if (!this.cursor) return;
    this.saveUndo('delete');
    const from = this.prevPos();
    // Backspace between an empty pair removes both: "|" → nothing.
    const pair = PAIRS[this.buf[from]];
    const to = pair && this.buf[this.cursor] === pair && this.shell && this.autoPair() ? this.cursor + 1 : this.cursor;
    this.buf = this.buf.slice(0, from) + this.buf.slice(to);
    this.cursor = from;
  }

  deleteForward() {
    if (this.cursor >= this.buf.length) return;
    this.saveUndo('delete');
    this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.nextPos());
  }

  wordStart() {
    let i = this.cursor;
    while (i > 0 && /[\s/=]/.test(this.buf[i - 1])) i--;
    while (i > 0 && !/[\s/=]/.test(this.buf[i - 1])) i--;
    return i;
  }

  wordEnd() {
    let i = this.cursor;
    while (i < this.buf.length && /[\s/=]/.test(this.buf[i])) i++;
    while (i < this.buf.length && !/[\s/=]/.test(this.buf[i])) i++;
    return i;
  }

  // Start of the whitespace-separated word before the cursor (for ^W).
  bigWordStart() {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buf[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buf[i - 1])) i--;
    return i;
  }

  deleteWordBack() {
    this.kill(this.bigWordStart(), this.cursor);
  }

  // Alt-. inserts the last word of the previous command; pressing it again
  // walks further back through history.
  insertLastArg() {
    const hist = this.history;
    if (!hist.length) return;
    let idx;
    if (this.lastArgIdx && this.lastArgIdx.cursor === this.cursor && this.lastArgIdx.buf === this.buf) {
      idx = this.lastArgIdx.idx - 1;
      this.buf = this.buf.slice(0, this.lastArgIdx.start) + this.buf.slice(this.cursor);
      this.cursor = this.lastArgIdx.start;
    } else {
      idx = hist.length - 1;
      this.saveUndo('lastarg');
    }
    if (idx < 0) idx = 0;
    const words = hist[idx].trim().split(/\s+/);
    const word = words[words.length - 1] || '';
    const start = this.cursor;
    this.insert(word);
    this.lastArgIdx = { idx, start, cursor: this.cursor, buf: this.buf };
  }

  // Capitalise, upper- or lower-case the word after the cursor (Alt-c/u/l).
  caseWord(how) {
    const end = this.wordEnd();
    let i = this.cursor;
    while (i < end && /[\s/=]/.test(this.buf[i])) i++;
    const word = this.buf.slice(i, end);
    if (!word) return;
    this.saveUndo('case');
    const done = how === 'u' ? word.toUpperCase() : how === 'l' ? word.toLowerCase()
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    this.buf = this.buf.slice(0, i) + done + this.buf.slice(end);
    this.cursor = end;
  }

  // Ctrl-T swaps the two characters around the cursor.
  transpose() {
    if (this.buf.length < 2 || this.cursor === 0) return;
    this.saveUndo('transpose');
    let at = this.cursor;
    if (at >= this.buf.length) at = this.prevPos(at);
    const a = this.prevPos(at);
    const b = this.nextPos(at);
    this.buf = this.buf.slice(0, a) + this.buf.slice(at, b) + this.buf.slice(a, at) + this.buf.slice(b);
    this.cursor = b;
  }

  autoPair() {
    const v = this.shell && this.shell.getVar && this.shell.getVar('AUTOPAIR');
    return !/^(0|off|no|false)$/i.test(String(v ?? 'on'));
  }

  // Typing an opening quote or bracket adds its partner when the cursor is
  // at the end of a word; typing the partner over it steps past instead.
  typeChar(ch) {
    this.saveUndo('type');
    if (this.autoPair() && !this.pasting) {
      const next = this.buf[this.cursor];
      const prev = this.buf[this.cursor - 1];
      // Only while still typing after we added it (any other key forgets).
      if (CLOSERS.has(ch) && next === ch && this.pairs) { this.cursor++; return; }
      const close = PAIRS[ch];
      const quote = ch === '"' || ch === "'" || ch === '`';
      if (close && (next === undefined || /[\s)\]}|;&]/.test(next))
        && !(quote && prev !== undefined && /[\w$\\]/.test(prev))
        && !(prev === '\\')
        && !(quote && this.insideQuote(ch))) {
        this.insert(ch + close);
        this.cursor--;
        this.pairs = true;
        return;
      }
    }
    this.insert(ch);
  }

  insideQuote(q) {
    let open = false;
    for (let i = 0; i < this.cursor; i++) {
      if (this.buf[i] === '\\' && q !== "'") { i++; continue; }
      if (this.buf[i] === q) open = !open;
    }
    return open;
  }

  // Abbreviations (abbr gco='git checkout') expand as you type a space or
  // press Enter after one in command position.
  expandAbbreviation() {
    const abbrs = this.shell && this.shell.abbrs;
    if (!abbrs || !abbrs.size) return false;
    const before = this.buf.slice(0, this.cursor);
    const m = /(^|[;&|(]\s*|\bthen\s+|\bdo\s+|\belse\s+|&&\s*|\|\|\s*)([^\s;&|()]+)$/.exec(before);
    if (!m || !abbrs.has(m[2])) return false;
    this.saveUndo('abbr');
    const start = this.cursor - m[2].length;
    const text = abbrs.get(m[2]);
    this.buf = this.buf.slice(0, start) + text + this.buf.slice(this.cursor);
    this.cursor = start + text.length;
    return true;
  }

  acceptSuggestion() {
    if (!this.suggestion) return false;
    this.saveUndo('accept');
    this.buf = this.suggestion;
    this.cursor = this.buf.length;
    this.suggestion = '';
    return true;
  }

  // Right-arrow at end of line accepts the ghost suggestion, like fish.
  forwardOrAccept() {
    if (this.cursor >= this.buf.length) {
      this.acceptSuggestion();
      return;
    }
    this.cursor = this.nextPos();
  }

  updateSuggestion() {
    this.suggestion = '';
    if (this.menu) return;
    if (!this.buf || this.cursor !== this.buf.length) return;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i];
      if (entry.length > this.buf.length && entry.startsWith(this.buf) && !entry.includes('\n')) {
        this.suggestion = entry;
        return;
      }
    }
  }

  // ↑ and ↓ walk history. With something typed, only commands that start
  // with it are visited (like zsh's up-line-or-beginning-search).
  historyPrev() {
    if (!this.history.length) return;
    if (this.histIdx === this.history.length) this.stash = this.buf;
    const prefix = this.stash;
    let i = this.histIdx - 1;
    while (i >= 0 && (this.history[i] === this.buf || !this.history[i].startsWith(prefix))) i--;
    if (i < 0) return;
    this.histIdx = i;
    this.buf = this.history[i];
    this.cursor = this.buf.length;
  }

  historyNext() {
    if (this.histIdx >= this.history.length) return;
    const prefix = this.stash;
    let i = this.histIdx + 1;
    while (i < this.history.length && (this.history[i] === this.buf || !this.history[i].startsWith(prefix))) i++;
    this.histIdx = i;
    this.buf = i >= this.history.length ? this.stash : this.history[i];
    this.cursor = this.buf.length;
  }

  complete() {
    if (!this.completeFn) return;
    const res = this.completeFn(this.buf, this.cursor, this.shell);
    const { items, partial } = res;
    if (!items.length) return;

    if (items.length === 1) {
      this.insertCompletion(items[0], partial);
      return;
    }
    const shared = commonPrefix(items);
    if (shared.length > partial.length) {
      const start = this.cursor - partial.length;
      this.buf = this.buf.slice(0, start) + shared + this.buf.slice(this.cursor);
      this.cursor = start + shared.length;
    }
    this.openMenu(this.completeFn(this.buf, this.cursor, this.shell));
  }

  insertCompletion(item, partial) {
    this.saveUndo('complete');
    const text = item.endsWith('/') ? item : `${item} `;
    const start = this.cursor - partial.length;
    this.buf = this.buf.slice(0, start) + text + this.buf.slice(this.cursor);
    this.cursor = start + text.length;
  }

  // --- the completion menu ------------------------------------------------------

  openMenu(res) {
    if (!res || !res.items.length) { this.menu = null; return; }
    this.menu = { items: res.items, info: res.info || new Map(), partial: res.partial, index: 0, top: 0 };
    this.suggestion = '';
  }

  // Re-runs completion after typing, keeping the menu open while anything matches.
  refreshMenu() {
    const res = this.completeFn(this.buf, this.cursor, this.shell);
    if (!res.items.length) { this.menu = null; return; }
    const keep = this.menu && this.menu.items[this.menu.index];
    this.openMenu(res);
    const at = keep ? res.items.indexOf(keep) : -1;
    if (at !== -1) this.menu.index = at;
  }

  handleMenuKey(str, key) {
    const m = this.menu;
    const name = key.name;
    const move = (d) => { m.index = (m.index + d + m.items.length) % m.items.length; };
    if ((name === 'tab' && !key.shift) || name === 'down' || (key.ctrl && name === 'n')) { move(1); return this.render(); }
    if ((name === 'tab' && key.shift) || name === 'up' || (key.ctrl && name === 'p')) { move(-1); return this.render(); }
    if (name === 'return' || name === 'enter' || name === 'right') {
      const item = m.items[m.index];
      this.menu = null;
      this.insertCompletion(item, m.partial);
      this.updateSuggestion();
      return this.render();
    }
    if (name === 'escape' || (key.ctrl && (name === 'c' || name === 'g'))) {
      this.menu = null;
      return this.render();
    }
    if (name === 'backspace') {
      this.deleteBack();
      this.refreshMenu();
      return this.render();
    }
    if (str && !key.ctrl && !key.meta && str.charCodeAt(0) > 32) {
      this.insert(str);
      this.refreshMenu();
      return this.render();
    }
    // Anything else closes the menu and is handled normally.
    this.menu = null;
    return undefined;
  }

  // Rows drawn under the input line: icon, name, and a muted description.
  menuLines(cols) {
    const m = this.menu;
    const { fit, textWidth } = require('./tui');
    const theme = require('./theme');
    const { ui } = theme.current();
    const width = cols - 1;
    const maxRows = Math.max(3, Math.min(8, (this.output.rows || 24) - 4));
    if (m.index < m.top) m.top = m.index;
    if (m.index >= m.top + maxRows) m.top = m.index - maxRows + 1;
    const shown = m.items.slice(m.top, m.top + maxRows);
    const labelOf = (i) => (m.info.get(i) || {}).label ?? i;
    const nameW = Math.min(Math.max(...shown.map((i) => textWidth(labelOf(i)))), Math.floor(width * 0.45));
    const R = ansi.reset();

    const lines = shown.map((item, i) => {
      const meta = m.info.get(item) || {};
      let icon = meta.icon || ' ';
      if (textWidth(icon) < 2) icon += ' ';
      const selected = m.top + i === m.index;
      const head = ` ${icon} ${fit(meta.label ?? item, nameW)}  `;
      const descW = Math.max(0, width - textWidth(head));
      const desc = meta.desc ? fit(meta.desc, descW) : ' '.repeat(descW);
      if (selected) {
        return `${ansi.sgr(`48;5;${ui.select.bg}`)}${ansi.fg(ui.select.fg)}${head}${desc}${R}`;
      }
      return `${head}${ansi.fg(ui.muted)}${desc}${R}`;
    });
    if (m.items.length > maxRows) {
      const more = `${m.index + 1} of ${m.items.length} · tab / ↑↓ to move · enter to pick`;
      lines.push(`${ansi.fg(ui.muted)}${fit(`  ${more}`, width)}${R}`);
    }
    return lines;
  }

  // --- Ctrl-R: fuzzy history search -------------------------------------------

  startSearch() {
    if (!this.searchHistory) return;
    this.search = { query: '', index: 0, saved: this.buf, savedCursor: this.cursor, rows: [] };
    this.refreshSearch();
  }

  refreshSearch() {
    const s = this.search;
    s.rows = this.searchHistory(s.query);
    s.index = Math.min(s.index, Math.max(0, s.rows.length - 1));
  }

  endSearch(accept) {
    const s = this.search;
    this.search = null;
    const row = s.rows[s.index];
    if (accept && row) {
      this.buf = row.cmd;
      this.cursor = this.buf.length;
    } else {
      this.buf = s.saved;
      this.cursor = s.savedCursor;
    }
  }

  handleSearchKey(str, key) {
    const s = this.search;
    const name = key.name;
    if ((key.ctrl && (name === 'c' || name === 'g')) || name === 'escape') {
      this.endSearch(false);
    } else if (name === 'return' || name === 'enter') {
      this.endSearch(true);
      this.suggestion = '';
      this.render();
      return this.finish({ line: this.buf });
    } else if (name === 'tab' || name === 'right') {
      this.endSearch(true);
    } else if (name === 'up' || (key.ctrl && name === 'p')) {
      s.index = Math.max(0, s.index - 1);
    } else if (name === 'down' || (key.ctrl && (name === 'n' || name === 'r'))) {
      s.index = Math.min(Math.max(0, s.rows.length - 1), s.index + 1);
    } else if (name === 'backspace') {
      s.query = s.query.slice(0, -1);
      s.index = 0;
      this.refreshSearch();
    } else if (key.ctrl && name === 'u') {
      s.query = '';
      s.index = 0;
      this.refreshSearch();
    } else if (str && !key.ctrl && !key.meta && str.charCodeAt(0) >= 32) {
      s.query += str;
      s.index = 0;
      this.refreshSearch();
    }
    this.updateSuggestion();
    return this.render();
  }

  // --- key handling ---------------------------------------------------------

  handleKey(str, key) {
    const name = key.name;

    // A pasted block goes in as typed, newlines and all.
    if (name === 'paste-start') { this.pasting = true; this.saveUndo('paste'); return undefined; }
    if (name === 'paste-end') { this.pasting = false; this.updateSuggestion(); return this.render(); }
    if (this.pasting) {
      if (str === '\r' || str === '\n' || name === 'return' || name === 'enter') this.insert('\n');
      else if (str === '\t' || name === 'tab') this.insert('\t');
      else if (str && str.charCodeAt(0) >= 32) this.insert(str);
      return undefined;
    }

    if (this.search) return this.handleSearchKey(str, key);
    if (this.menu) {
      const handled = this.handleMenuKey(str, key);
      if (handled !== undefined || this.menu) return handled;
    }
    if (!(key.meta && key.sequence === '\x1b.')) this.lastArgIdx = null;
    if (name !== 'up' && name !== 'down' && !(key.ctrl && (name === 'p' || name === 'n'))) this.histIdx = this.history.length;
    if (!['backspace', 'delete'].includes(name) && !(str && str.length === 1 && str.charCodeAt(0) >= 32)) this.pairs = null;

    // An offered fix is run by Enter on an empty line, taken into the line
    // by → or ^E, and forgotten as soon as anything else is typed.
    if (this.fix && !this.buf) {
      if (name === 'return' || name === 'enter') {
        const line = this.fix;
        this.fix = null;
        this.buf = line;
        this.cursor = line.length;
        this.render();
        return this.finish({ line });
      }
      if (name === 'right' || (key.ctrl && name === 'e')) {
        this.buf = this.fix;
        this.cursor = this.buf.length;
        this.fix = null;
        return this.render();
      }
      if (!(key.ctrl && name === 'r')) this.fix = null;
    }

    // ^_ (and ^/) undo; some terminals send it without a key name.
    if (str === '\x1f' || (key.ctrl && (name === '_' || name === '/'))) {
      this.undoEdit();
      this.updateSuggestion();
      return this.render();
    }

    if (key.ctrl && (name === 'left' || name === 'right')) {
      this.cursor = name === 'left' ? this.wordStart() : this.wordEnd();
      this.updateSuggestion();
      return this.render();
    }

    if (key.ctrl) {
      switch (name) {
        case 'r': this.startSearch(); break;
        case 'c':
          this.output.write(`${ansi.fg('gray')}^C${ansi.reset()}`);
          return this.finish({ line: '', aborted: true });
        case 'd':
          if (!this.buf) return this.finish({ line: '', eof: true });
          this.deleteForward();
          break;
        case 'a': this.cursor = 0; break;
        case 'e':
          this.acceptSuggestion();
          this.cursor = this.buf.length;
          break;
        case 'b': this.cursor = this.prevPos(); break;
        case 'f': this.forwardOrAccept(); break;
        case 'h': this.deleteBack(); break;
        case 'k': this.kill(this.cursor, this.buf.length); break;
        case 'u': this.kill(0, this.cursor); break;
        case 'w': this.deleteWordBack(); break;
        case 'y': this.yank(); break;
        case 't': this.transpose(); break;
        case 'p': this.historyPrev(); break;
        case 'n': this.historyNext(); break;
        case 'delete': this.kill(this.cursor, this.wordEnd()); break;
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
      if (name === 'b' || name === 'left') this.cursor = this.wordStart();
      else if (name === 'f' || name === 'right') this.cursor = this.wordEnd();
      else if (name === 'd' || name === 'delete') this.kill(this.cursor, this.wordEnd());
      else if (name === 'backspace') this.kill(this.wordStart(), this.cursor);
      else if (name === '.' || key.sequence === '\x1b.') this.insertLastArg();
      else if (name === 'u' || name === 'l' || name === 'c') this.caseWord(name);
      else if (name === 'return' || name === 'enter') { this.insert('\n'); }
      this.updateSuggestion();
      return this.render();
    }

    switch (name) {
      case 'return': case 'enter':
        this.expandAbbreviation();
        this.suggestion = '';
        this.render();
        return this.finish({ line: this.buf });
      case 'backspace': this.deleteBack(); break;
      case 'delete': this.deleteForward(); break;
      case 'left': this.cursor = this.prevPos(); break;
      case 'right': this.forwardOrAccept(); break;
      case 'home': this.cursor = 0; break;
      case 'end': this.acceptSuggestion(); this.cursor = this.buf.length; break;
      case 'up': this.historyPrev(); break;
      case 'down': this.historyNext(); break;
      case 'tab': this.complete(); break;
      case 'escape': break;
      default:
        if (str === ' ' || name === 'space') this.expandAbbreviation();
        if (str && str.length >= 1 && str.charCodeAt(0) >= 32 && str !== '\t') {
          if ([...str].length === 1) this.typeChar(str); else { this.saveUndo('type'); this.insert(str); }
        }
        break;
    }

    this.updateSuggestion();
    return this.render();
  }

  // --- rendering ------------------------------------------------------------

  // Where each position lands on screen, given the prompt's width: wide
  // characters take two columns (and wrap early when only one is left), and
  // newlines in a pasted command start a new row.
  static layout(startCol, text, cols, marks = []) {
    let row = 0;
    let col = startCol;
    const at = new Map();
    let i = 0;
    const note = () => {
      if (marks.includes(i) && !at.has(i)) at.set(i, col >= cols ? { row: row + 1, col: 0 } : { row, col });
    };
    for (const ch of text) {
      note();
      if (ch === '\n') { row++; col = 0; i += ch.length; continue; }
      const w = ansi.charWidth(ch.codePointAt(0));
      if (w && col + w > cols) { row++; col = 0; }
      col += w;
      i += ch.length;
    }
    note();
    const wrapped = col >= cols && text.length > 0;
    return { endRow: wrapped ? row + 1 : row, wrapped, at };
  }

  render() {
    if (this.search) return this.renderSearch();
    const cols = this.columns;
    let s = '';

    if (this.cursorRowPos > 0) s += `\x1b[${this.cursorRowPos}A`;
    s += '\r\x1b[J';

    // With the menu open, the line previews the highlighted choice.
    let buf = this.buf;
    let cursor = this.cursor;
    if (this.menu) {
      const item = this.menu.items[this.menu.index];
      const text = item.endsWith('/') ? item : `${item} `;
      const start = this.cursor - this.menu.partial.length;
      buf = this.buf.slice(0, start) + text + this.buf.slice(this.cursor);
      cursor = start + text.length;
    }

    const painted = this.highlightFn(buf, this.shell);
    let ghostText = this.suggestion ? this.suggestion.slice(buf.length) : '';
    let ghost = ghostText ? `${ansi.dim()}${ghostText}${ansi.reset()}` : '';
    if (!buf && this.fix) {
      const hint = '   ⏎ runs it';
      if (ansi.width(this.prompt) + ansi.width(this.fix) + hint.length < cols) {
        ghostText = this.fix + hint;
        ghost = `${ansi.dim()}${this.fix}${ansi.reset()}${ansi.fg('gray')}${hint}${ansi.reset()}`;
      }
    }

    const promptW = ansi.width(this.prompt);
    const all = LineEditor.layout(promptW, buf + ghostText, cols, [cursor]);
    const endRow = all.endRow;

    if (this.rprompt && !buf.includes('\n')) {
      const rw = ansi.width(this.rprompt);
      const totalW = promptW + ansi.width(buf) + ansi.width(ghostText);
      if (totalW + rw + 2 <= cols) s += `\x1b[${cols - rw + 1}G${this.rprompt}\r`;
    }

    s += this.prompt + (painted + ghost).replace(/\n/g, '\x1b[K\r\n');
    // Force the wrap deterministically when we land exactly on a boundary.
    if (all.wrapped) s += '\r\n';
    const menu = this.menu ? this.menuLines(cols) : [];
    if (menu.length) s += `\r\n${menu.join('\r\n')}`;
    const bottom = endRow + menu.length;

    const pos = all.at.get(cursor) || { row: endRow, col: 0 };

    if (bottom > 0) s += `\x1b[${bottom}A`;
    s += '\r';
    if (pos.row > 0) s += `\x1b[${pos.row}B`;
    if (pos.col > 0) s += `\x1b[${pos.col}C`;

    this.cursorRowPos = pos.row;
    this.lastEndRow = bottom;
    this.output.write(s);
  }

  // The line shows the selected command; the matches are listed underneath,
  // and the terminal cursor sits in the query field.
  renderSearch() {
    const cols = this.columns;
    const s = this.search;
    const { ago } = require('./history');
    const path = require('path');
    const maxRows = Math.max(3, Math.min(10, (this.output.rows || 24) - 4));
    const width = cols - 1;
    let out = '';
    if (this.cursorRowPos > 0) out += `\x1b[${this.cursorRowPos}A`;
    out += '\r\x1b[J';

    const current = s.rows[s.index];
    const shown = current ? current.cmd.replace(/\n/g, '↵') : '';
    const promptW = ansi.width(this.prompt);
    const room = Math.max(0, width - promptW);
    const clipped = [...shown].slice(0, room).join('');
    out += this.prompt + this.highlightFn(clipped, this.shell);

    const total = s.rows.length;
    const count = total ? `${s.index + 1} of ${total}` : 'no matches';
    const label = `history › ${s.query}`;
    const pad = Math.max(1, width - ansi.width(label) - count.length);
    const accent = require('./theme').fg('accent');
    const { ui } = require('./theme').current();
    const selOn = `${ansi.sgr(`48;5;${ui.select.bg}`)}${ansi.fg(ui.select.fg)}`;
    out += `\r\n${accent}history ›${ansi.reset()} ${s.query}${' '.repeat(pad)}${ansi.fg('gray')}${count}${ansi.reset()}`;

    // Keep the selection inside the visible window.
    const top = Math.max(0, Math.min(s.index - Math.floor(maxRows / 2), total - maxRows));
    const rows = s.rows.slice(top, top + maxRows);
    rows.forEach((row, i) => {
      const selected = top + i === s.index;
      const meta = `${row.lastCwd ? path.basename(row.lastCwd) : ''}${row.here ? ' •' : ''}  ${ago(row.lastTs)}`.trim();
      const cmdRoom = Math.max(4, width - 2 - meta.length - 2);
      const chars = [...row.cmd.replace(/\n/g, '↵')];
      let text = '';
      for (let c = 0; c < Math.min(chars.length, cmdRoom); c++) {
        const hit = row.positions && row.positions.has(c);
        text += hit ? `${ansi.bold()}${require('./theme').fg('accent2')}${chars[c]}${ansi.reset()}${selected ? selOn : ''}` : chars[c];
      }
      const used = Math.min(chars.length, cmdRoom);
      const gap = ' '.repeat(Math.max(1, width - 2 - used - meta.length));
      const line = `${selected ? '›' : ' '} ${text}${gap}${ansi.fg('gray')}${meta}${ansi.reset()}`;
      out += `\r\n${selected ? selOn : ''}${line}${ansi.reset()}`;
    });

    // Park the cursor after the query text on the header row.
    const listRows = rows.length;
    out += `\x1b[${listRows}A\r\x1b[${Math.min(width, ansi.width(label))}C`;
    this.cursorRowPos = 1;
    this.lastEndRow = 1 + listRows;
    this.output.write(out);
  }

}

module.exports = { LineEditor };
