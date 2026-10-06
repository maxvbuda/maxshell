'use strict';

// Markdown for the terminal, written as it streams in (Sage's replies):
// headings, **bold**, *italic*, ~~struck~~, `code`, links, lists, quotes,
// rules, tables, fenced code coloured by syntax.js, and TeX math ($…$,
// $$…$$, \(…\), \[…\]) as Unicode text by tex.js. Words are written as
// soon as they end and wrap to the terminal width. The start of a line is
// held only until its kind (heading, item, fence…) is known, an emphasis
// only until its closing marker shows up, and a table until its last row —
// so rendering all at once and a character at a time give the same output.
//
// As a program (`node markdown.js COL`) it renders stdin to the terminal
// for gemma.py: a NUL ends a reply and is answered with a NUL on stderr once
// the reply is on the screen. COL is where each reply starts (after the
// "✦ gemma ❯ " tag).

const ansi = require('./ansi');
const theme = require('./theme');
const syntax = require('./syntax');
const { paintSpans } = require('./paint');
const { fit } = require('./tui');
const { texToText, texLines } = require('./tex');

const FENCE_LANGS = {
  py: 'python', python: 'python', python3: 'python',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript',
  ts: 'javascript', typescript: 'javascript', tsx: 'javascript',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', terminal: 'shell',
  c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp',
  json: 'json', md: 'markdown', markdown: 'markdown',
};
// Code in a language syntax.js doesn't know is all in the code colour.
const PLAIN_CODE = { tokenize: (line) => ({ spans: [{ text: line, cls: 'code' }], endState: null }) };
const BULLETS = ['•', '◦', '▪'];
const LINK = /^\[([^\]\n]{0,200})\]\(([^)\s]{0,500})\)/;
const MAYBE_LINK = /^\[[^\]\n]{0,200}(\](\([^)\s]{0,500})?)?$/;
const URL = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_`]/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

// How many of s[i] there are in a row from i.
function run(s, i) {
  let n = 1;
  while (s[i + n] === s[i]) n++;
  return n;
}

// Whether a marker opened at j (n of c) is closed later in s. A run at the
// very end of s might still grow, so it only counts once the line is done.
function closes(s, j, c, n, final) {
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`' || ch === c) {
      const m = run(s, j);
      if (j + m >= s.length && !final) return false;
      if (ch === c) {
        if (c === '`') { if (m === n) return true; } else {
          const next = j + m < s.length ? s[j + m] : ' ';
          if (m >= n && !SPACE.test(s[j - 1]) && (c !== '_' || !WORD.test(next))) return true;
        }
      } else if (c !== '`') {
        // skip a code span: markers inside it don't count
        const end = s.indexOf('`'.repeat(m), j + m);
        if (end >= 0) { j = end + m; continue; }
      }
      j += m;
      continue;
    }
    j++;
  }
  return false;
}

class MarkdownStream {
  // `out` gets the terminal text; `width` is a number or a function (the
  // terminal can be resized mid-reply); `col` is where the first line starts;
  // `live` writes code as it comes and recolours each line once it's whole.
  constructor({ out, width = 80, col = 0, live = false, inline = false, style = '' } = {}) {
    this.out = out;
    this.width = typeof width === 'function' ? width : () => width;
    this.start = col;
    this.live = live;
    this.inlineOnly = inline;
    this.paraStyle = style;
    this.reset();
  }

  reset() {
    this.col = this.start;
    this.wrote = false;  // anything written this reply
    this.nl = 0;         // line breaks owed before the next output
    this.fence = null;   // { mark, lang, state } inside a fenced code block
    this.table = [];     // rows of the table being collected
    this.lists = [];     // indents of the open list levels
    this.math = null;    // { close, tex } inside a display math block
    this.newLine();
  }

  newLine() {
    this.line = '';      // the line so far
    this.done = 0;       // how much of it has been dealt with
    this.kind = null;    // what it is, once that's known
    this.span = { bold: false, italic: false, strike: false, code: 0, link: false, url: false, math: false };
    this.base = '';      // the line's own style (heading, quote)
    this.pad = '';       // what a wrapped line starts with
    this.padW = 0;
    this.sgr = '';       // the style at the end of `word`
    this.word = '';      // the word being built, with its escapes
    this.wordW = 0;
    this.wordSgr = '';   // the style in effect when `word` began
    this.space = false;  // a space is owed before the next word
  }

  write(text) {
    const parts = String(text).replace(/\r/g, '').split('\n');
    parts.forEach((part, i) => {
      this.line += part;
      this.pump(false);
      if (i < parts.length - 1) this.finish();
    });
  }

  // Ends the reply: what's held is written, and owed line breaks dropped,
  // so the cursor stays at the end of the last line.
  end() {
    if (this.line) this.finish();
    this.flushTable();
    if (this.wrote) this.out(ansi.reset());
    this.reset();
  }

  // Writes `s` (w columns), first paying any owed line breaks.
  put(s, w = ansi.width(s)) {
    if (this.nl) {
      this.out('\n'.repeat(this.nl));
      this.col = 0;
      this.nl = 0;
    }
    this.out(s);
    this.col += w;
    this.wrote = true;
  }

  // Blocks (code, rules, tables) start on a line of their own, even first.
  block() {
    if (this.col > 0 && !this.nl) this.nl = 1;
  }

  // What the line is, or null while that can't be told yet.
  classify(final) {
    const s = this.line;
    if (this.inlineOnly) return 'para';
    if (this.fence) {
      if (/^\s*([`~])\1*\s*$/.test(s) || /^\s*$/.test(s)) {
        if (!final) return null;
        const f = /^\s*(`+|~+)\s*$/.exec(s);
        return f && f[1][0] === this.fence.mark[0] && f[1].length >= this.fence.mark.length ? 'close' : 'code';
      }
      return 'code';
    }
    if (this.math) return final ? 'mathline' : null;
    const t = s.trimStart();
    if (!t) return final ? 'blank' : null;
    if (/^(\$\$|\\\[)/.test(t) || t === '$' || t === '\\') {
      if (!final) return null;
      const m = /^(\$\$|\\\[)/.exec(t);
      if (!m) return 'para';
      const close = m[1] === '$$' ? '$$' : '\\]';
      const at = t.indexOf(close, 2);
      if (at < 0) return 'mathopen';
      return at === t.trimEnd().length - close.length ? 'math' : 'para';
    }
    if (/^(`{3,}|~{3,})/.test(t)) return final ? 'open' : null;
    if (/^(`{1,2}|~{1,2})$/.test(t)) return final ? 'para' : null;
    if (/^#{1,6}$/.test(t)) return final ? 'heading' : null;
    if (/^#{1,6}\s/.test(t)) return 'heading';
    if (/^[-*+]\s/.test(t) || /^\d{1,9}[.)]\s/.test(t)) return 'item';
    if (/^([-*_])\1*$/.test(t) || t === '+') return final ? (/^([-*_])\1{2,}$/.test(t) ? 'rule' : 'para') : null;
    if (/^([-*_])\1{2,}\s+$/.test(t)) return final ? 'rule' : null;
    if (/^\d{1,9}[.)]?$/.test(t)) return final ? 'para' : null;
    if (t[0] === '>') return 'quote';
    if (t[0] === '|') return 'table';
    return 'para';
  }

  pump(final) {
    if (!this.kind) {
      this.kind = this.classify(final);
      if (!this.kind) return;
      if (this.kind !== 'table') this.flushTable();
      this.begin();
    }
    if (this.kind === 'code') this.codeText();
    else if (['para', 'heading', 'item', 'quote'].includes(this.kind)) this.inline(final);
  }

  // Writes what starts the line (a bullet, a quote bar) and sets the style
  // and the indent of wrapped lines.
  begin() {
    const s = this.line;
    const indent = s.length - s.trimStart().length;
    const t = s.slice(indent);
    const { syntax: sy } = theme.current();
    const lead = (first, firstW, pad, padW) => {
      this.put(first, firstW);
      this.pad = pad;
      this.padW = padW;
    };
    if (this.kind === 'code') {
      if (this.live) this.put(theme.style(sy.code), 0);
    } else if (this.kind === 'heading') {
      this.lists = [];
      this.base = theme.style(sy.heading);
      this.done = indent + /^#+\s*/.exec(t)[0].length;
      lead('', 0, '', 0);
    } else if (this.kind === 'item') {
      const m = /^([-*+]|\d{1,9}[.)])\s+/.exec(t);
      while (this.lists.length && indent < this.lists[this.lists.length - 1]) this.lists.pop();
      if (!this.lists.length || indent > this.lists[this.lists.length - 1]) this.lists.push(indent);
      const mark = /\d/.test(m[1]) ? m[1] : BULLETS[Math.min(this.lists.length - 1, BULLETS.length - 1)];
      const w = indent + ansi.width(mark) + 1;
      this.done = indent + m[0].length;
      lead(`${' '.repeat(indent)}${theme.style(sy.bullet)}${mark}${ansi.reset()} `, w, ' '.repeat(w), w);
    } else if (this.kind === 'quote') {
      this.lists = [];
      const m = /^(>\s?)+/.exec(t);
      const depth = m[0].split('>').length - 1;
      const bar = `${' '.repeat(indent)}${theme.style(sy.quote)}${'│ '.repeat(depth)}${ansi.reset()}`;
      this.base = theme.style(sy.quote);
      this.done = indent + m[0].length;
      lead(bar, indent + 2 * depth, bar, indent + 2 * depth);
    } else if (this.kind === 'para') {
      if (!indent) this.lists = [];
      this.base = this.paraStyle;
      this.done = indent;
      lead(' '.repeat(indent), indent, ' '.repeat(indent), indent);
    } else if (this.kind === 'open' || this.kind === 'rule') {
      this.lists = [];
    }
  }

  // The line is complete.
  finish() {
    this.pump(true);
    const { ui } = theme.current();
    switch (this.kind) {
      case 'blank':
        if (this.wrote) this.nl = 2;
        break;
      case 'open': {
        const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(this.line);
        const lang = syntax.languageById(FENCE_LANGS[m[2].toLowerCase()]) || PLAIN_CODE;
        this.fence = { mark: m[1], lang, state: null };
        if (m[2]) {
          this.block();
          this.put(`${theme.style(ui.muted)}${m[2]}${ansi.reset()}`);
          this.nl = 1;
        } else {
          this.block();
        }
        break;
      }
      case 'close':
        this.fence = null;
        break;
      case 'math': {
        const t = this.line.trim();
        this.displayMath(t.slice(2, -2));
        break;
      }
      case 'mathopen': {
        const t = this.line.trim();
        this.math = { close: t.startsWith('$$') ? '$$' : '\\]', tex: t.slice(2) };
        break;
      }
      case 'mathline': {
        const t = this.line.trim();
        if (t.endsWith(this.math.close)) {
          this.displayMath(`${this.math.tex} ${t.slice(0, -2)}`);
          this.math = null;
        } else {
          this.math.tex += ` ${t}`;
        }
        break;
      }
      case 'code':
        this.codeLine();
        this.nl = 1;
        break;
      case 'rule':
        this.block();
        this.put(`${theme.style(ui.muted)}${'─'.repeat(Math.min(this.width(), 80))}${ansi.reset()}`);
        this.nl = 1;
        break;
      case 'table':
        this.table.push(this.line);
        break;
      default: // text
        this.flushWord();
        if (this.sgr) this.put(ansi.reset(), 0);
        this.nl = 1;
    }
    this.newLine();
  }

  // Display math: each row on a line of its own, indented, wrapping there.
  displayMath(tex) {
    this.lists = [];
    this.block();
    for (const row of texLines(tex)) {
      this.pad = '    ';
      this.padW = 4;
      this.put(this.pad, 4);
      this.mathText(row);
      this.flushWord();
      this.put(ansi.reset(), 0);
      this.sgr = '';
      this.nl = 1;
    }
  }

  mathText(text) {
    this.span.math = true;
    this.restyle();
    for (const part of text.split(/( +)/)) {
      if (part[0] === ' ') this.gap();
      else if (part) this.add(part);
    }
    this.span.math = false;
    this.restyle();
  }

  // Inline math starting at s[i]: { tex, end }, false when it isn't math,
  // or null while its end may still be coming.
  mathAt(s, i, final) {
    const open = s.startsWith('$$', i) ? '$$' : s[i] === '$' ? '$' : s.slice(i, i + 2);
    const close = { $$: '$$', $: '$', '\\(': '\\)', '\\[': '\\]' }[open];
    if (!close) return false;
    const from = i + open.length;
    if (open === '$') {
      // $x$ (pandoc's rule): no space just inside, no digit right after —
      // so "$5 and $10" stays money.
      if (from >= s.length) return final ? false : null;
      if (SPACE.test(s[from])) return false;
      for (let j = from + 1; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] !== '$' || SPACE.test(s[j - 1])) continue;
        if (j + 1 >= s.length && !final) return null;
        if (/\d/.test(s[j + 1] || '')) continue;
        return { tex: s.slice(from, j), end: j + 1 };
      }
      return final ? false : null;
    }
    const j = s.indexOf(close, from);
    if (j < 0) return final ? false : null;
    return { tex: s.slice(from, j), end: j + close.length };
  }

  // --- code -----------------------------------------------------------------

  codeText() {
    if (!this.live) return;
    const s = this.line.slice(this.done).replace(/\t/g, '    ');
    if (s) this.put(s);
    this.done = this.line.length;
  }

  codeLine() {
    const text = this.line.replace(/\t/g, '    ');
    const { spans, endState } = this.fence.lang.tokenize(text, this.fence.state);
    this.fence.state = endState;
    const painted = paintSpans(spans, 0, Infinity);
    if (!this.live) this.put(painted, ansi.width(text));
    else if (text && ansi.width(text) < this.width()) this.out(`\r${ansi.reset()}${painted}\x1b[K`);
    else if (text) this.out(ansi.reset());
  }

  // --- inline text ----------------------------------------------------------

  style() {
    const { syntax: sy, ui } = theme.current();
    const sp = this.span;
    let s = ansi.reset() + this.base;
    if (sp.bold) s += ansi.bold();
    if (sp.italic) s += ansi.sgr(3);
    if (sp.strike) s += ansi.sgr(9);
    if (sp.link) s += theme.style(sy.link);
    if (sp.url) s += theme.style(ui.muted);
    if (sp.code) s += theme.style(sy.code);
    if (sp.math) s += theme.style(sy.num);
    return s;
  }

  restyle() {
    const s = this.style();
    if (s === this.sgr) return;
    if (!this.word) this.wordSgr = this.sgr;
    this.word += s;
    this.sgr = s;
  }

  add(text) {
    this.restyle();
    this.word += text;
    this.wordW += ansi.width(text);
  }

  // Whitespace: the word before it is done.
  gap() {
    this.flushWord();
    if (this.word === '' && this.col > this.padW) this.space = true;
  }

  flushWord() {
    if (!this.word) return;
    if (this.wordW === 0) {
      this.put(this.word, 0);
    } else {
      const room = this.width() - this.col - (this.space ? 1 : 0);
      if (this.wordW > room && this.col > this.padW) {
        this.out(`${ansi.reset()}\n${this.pad}${this.wordSgr}`);
        this.col = this.padW;
      } else if (this.space) {
        this.put(' ');
      }
      this.put(this.word, this.wordW);
      this.space = false;
    }
    this.word = '';
    this.wordW = 0;
  }

  // Renders the line's complete words: everything up to its last space (or
  // all of it once the line is done), stopping early at a marker whose
  // closing half hasn't arrived yet.
  inline(final) {
    const s = this.line;
    const upto = final ? s.length : s.search(/\s\S*$/) + 1;
    const sp = this.span;
    let i = this.done;
    while (i < upto) {
      const c = s[i];
      if (sp.code) {
        if (c === '`') {
          const n = run(s, i);
          if (n === sp.code) { sp.code = 0; this.restyle(); } else this.add(s.slice(i, i + n));
          i += n;
        } else if (SPACE.test(c)) { this.gap(); i++; } else { this.add(c); i++; }
        continue;
      }
      if (SPACE.test(c)) { this.gap(); i++; continue; }
      if (c === '$' || (c === '\\' && (s[i + 1] === '(' || s[i + 1] === '['))) {
        const m = this.mathAt(s, i, final);
        if (m === null) break;
        if (m) { this.mathText(texToText(m.tex)); i = m.end; continue; }
      }
      if (c === '\\' && /[!-/:-@[-`{-~]/.test(s[i + 1] || '')) { this.add(s[i + 1]); i += 2; continue; }
      if (c === '`') {
        const n = run(s, i);
        if (closes(s, i + n, '`', n, final)) { sp.code = n; this.restyle(); i += n; continue; }
        if (!final) break;
        this.add(s.slice(i, i + n));
        i += n;
        continue;
      }
      if (c === '*' || c === '_' || c === '~') {
        const n = run(s, i);
        const prev = i > 0 ? s[i - 1] : ' ';
        const next = i + n < s.length ? s[i + n] : ' ';
        const keys = c === '~' ? (n === 2 ? ['strike'] : []) : [[], ['italic'], ['bold'], ['bold', 'italic']][n] || [];
        let canClose = !SPACE.test(prev);
        if (c === '_') canClose = canClose && !WORD.test(next);
        if (keys.length && keys.every((k) => sp[k]) && canClose) {
          for (const k of keys) sp[k] = false;
          this.restyle();
          i += n;
          continue;
        }
        if (keys.length && keys.every((k) => !sp[k]) && !SPACE.test(next) && !WORD.test(prev)) {
          if (closes(s, i + n, c, n, final)) {
            for (const k of keys) sp[k] = true;
            this.restyle();
            i += n;
            continue;
          }
          if (!final) break;
        }
        this.add(s.slice(i, i + n));
        i += n;
        continue;
      }
      if (c === '[' || (c === '!' && s[i + 1] === '[')) {
        const at = c === '!' ? i + 1 : i;
        const m = LINK.exec(s.slice(at));
        if (m) { this.link(m[1], m[2]); i = at + m[0].length; continue; }
        if (!final && MAYBE_LINK.test(s.slice(at))) break;
        this.add(c);
        i++;
        continue;
      }
      if (c === '<' || c === 'h') {
        const m = c === '<' ? /^<(https?:\/\/[^\s>]+)>/.exec(s.slice(i)) : (WORD.test(s[i - 1] || '') ? null : URL.exec(s.slice(i)));
        if (m) { this.link(m[1] || m[0], ''); i += m[0].length; continue; }
      }
      this.add(c);
      i++;
    }
    this.done = i;
  }

  link(text, url) {
    const sp = this.span;
    sp.link = true;
    for (const part of text.replace(/`|\*\*/g, '').split(/(\s+)/)) {
      if (SPACE.test(part)) this.gap();
      else if (part) this.add(part);
    }
    sp.link = false;
    this.restyle();
    if (url && url !== text && !url.startsWith('#')) {
      this.gap();
      sp.url = true;
      this.add(`(${url})`);
      sp.url = false;
      this.restyle();
    }
  }

  // --- tables ---------------------------------------------------------------

  // A cell's text with its inline markdown, and its width.
  cell(text, head) {
    let s = '';
    const md = new MarkdownStream({ out: (x) => { s += x; }, width: Infinity, inline: true, style: head ? ansi.bold() : '' });
    md.write(text);
    md.end();
    return { s, w: ansi.width(s), plain: ansi.strip(s) };
  }

  flushTable() {
    if (!this.table.length) return;
    const rows = this.table;
    this.table = [];
    const split = (line) => {
      let t = line.trim();
      if (t.startsWith('|')) t = t.slice(1);
      if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
      return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    };
    let cells = rows.map(split);
    let head = false;
    let align = [];
    if (rows.length > 1 && TABLE_RULE.test(rows[1])) {
      align = cells[1].map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left'));
      cells = [cells[0], ...cells.slice(2)];
      head = true;
    }
    const n = Math.max(...cells.map((r) => r.length));
    const shown = cells.map((r, ri) => Array.from({ length: n }, (_, j) => this.cell(r[j] || '', head && ri === 0)));
    const widths = Array.from({ length: n }, (_, j) => Math.max(1, ...shown.map((r) => r[j].w)));
    const total = () => widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
    const W = this.width();
    while (total() > W) {
      const j = widths.indexOf(Math.max(...widths));
      if (widths[j] <= 3) break;
      widths[j]--;
    }
    const muted = theme.style(theme.current().ui.muted);
    const show = (c, w, a) => {
      if (c.w > w) return fit(c.plain, w);
      const gap = w - c.w;
      const left = a === 'right' ? gap : a === 'center' ? Math.floor(gap / 2) : 0;
      return ' '.repeat(left) + c.s + ' '.repeat(gap - left);
    };
    const lines = shown.map((row) => row.map((c, j) => show(c, widths[j], align[j])).join(` ${muted}│${ansi.reset()} `));
    if (head) lines.splice(1, 0, `${muted}${widths.map((w) => '─'.repeat(w)).join('─┼─')}${ansi.reset()}`);
    this.block();
    for (const line of lines) {
      this.put(total() > W ? fit(ansi.strip(line), W).trimEnd() : line.replace(/ +$/, ''));
      this.nl = 1;
    }
  }
}

// Renders a whole piece of markdown at once.
function renderMarkdown(text, options = {}) {
  let s = '';
  const md = new MarkdownStream({ ...options, out: (x) => { s += x; } });
  md.write(text);
  md.end();
  return s;
}

module.exports = { MarkdownStream, renderMarkdown };

if (require.main === module) {
  const fs = require('fs');
  theme.loadSavedTheme();
  process.on('SIGINT', () => {}); // Ctrl-C is gemma.py's: it stops the answer
  const tty = process.stdout;
  const md = new MarkdownStream({
    col: Number(process.argv[2]) || 0, live: true,
    width: () => tty.columns || 80, out: (s) => tty.write(s),
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const parts = chunk.split('\0');
    parts.forEach((part, i) => {
      if (part) md.write(part);
      if (i < parts.length - 1) {
        md.end();
        fs.writeSync(2, '\0');
      }
    });
  });
}
