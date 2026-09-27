'use strict';

class ShellError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellError';
  }
}

// Thrown when the input ends in the middle of a construct, so the REPL knows
// to keep reading instead of reporting a syntax error.
class IncompleteError extends ShellError {
  constructor(message) {
    super(message);
    this.name = 'IncompleteError';
  }
}

const OPERATORS = [
  '<<<', '&>>', '<<-',
  '&&', '||', ';;', ';&', ';|', '>>', '<<', '>&', '<&', '&>', '|&',
  '|', '&', ';', '(', ')', '<', '>',
];

const REDIR_OPS = new Set(['<', '>', '>>', '<<', '<<-', '<<<', '>&', '<&', '&>', '&>>']);

const RESERVED = new Set([
  'if', 'then', 'elif', 'else', 'fi',
  'for', 'foreach', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'repeat', 'select', 'time', 'end',
  '{', '}', '!', '[[', ']]',
]);

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_PARAMS = '@*#?$!-0123456789';

class Token {
  constructor(type, value, extra) {
    this.type = type;
    this.value = value;
    if (extra) Object.assign(this, extra);
  }
}

class Lexer {
  constructor(src, opts = {}) {
    this.src = src;
    this.pos = 0;
    this.tokens = [];
    this.pendingHeredocs = [];
    this.heredocOp = null;
    this.wordMode = !!opts.wordMode;
    this.inCond = false;
  }

  error(msg) {
    throw new ShellError(msg);
  }

  get last() {
    return this.tokens[this.tokens.length - 1];
  }

  push(tok) {
    if (tok.start === undefined) tok.start = this.tokStart ?? this.pos;
    tok.end = this.pos;
    this.tokens.push(tok);
    return tok;
  }

  atCommandPosition() {
    const t = this.last;
    if (!t) return true;
    if (t.type === 'NEWLINE') return true;
    if (t.type === 'OP') return t.value !== ')';
    if (t.type === 'WORD' && t.reserved) return true;
    return false;
  }

  matchOperatorAt(i) {
    for (const op of OPERATORS) {
      if (this.src.startsWith(op, i)) return op;
    }
    return null;
  }

  tokenize() {
    for (;;) {
      this.skipBlanks();
      if (this.pos >= this.src.length) break;
      this.tokStart = this.pos;
      const c = this.src[this.pos];

      if (c === '#' && this.atWordStart()) {
        const nl = this.src.indexOf('\n', this.pos);
        this.pos = nl === -1 ? this.src.length : nl;
        continue;
      }
      if (c === '\n') {
        this.pos++;
        this.push(new Token('NEWLINE', '\n'));
        this.collectHeredocs();
        continue;
      }
      if (c === '\\' && this.src[this.pos + 1] === '\n') {
        this.pos += 2;
        continue;
      }

      const ionum = /^(\d+)(?=[<>])/.exec(this.src.slice(this.pos));
      if (ionum && this.prevCharIsDelimiter()) {
        this.pos += ionum[1].length;
        this.push(new Token('IONUM', ionum[1]));
        continue;
      }

      if (this.src.startsWith('((', this.pos) && this.atCommandPosition()) {
        const { content, end } = this.scanBalanced(this.pos, '(', ')');
        this.pos = end;
        this.push(new Token('ARITH', content.slice(1, -1)));
        continue;
      }

      // A [[ ]] pattern may start with a parenthesis: [[ $x == (a|b)* ]]
      if (c === '(' && this.condPatternWord()) {
        this.readWord();
        continue;
      }

      // <(cmd) and >(cmd): process substitution, a word of its own.
      const afterRedir = this.last && this.last.type === 'OP' && REDIR_OPS.has(this.last.value);
      if ((c === '<' || c === '>') && this.src[this.pos + 1] === '(' && (!this.atCommandPosition() || afterRedir)) {
        this.readWord();
        continue;
      }

      const op = this.matchOperatorAt(this.pos);
      if (op) {
        this.pos += op.length;
        const tok = this.push(new Token('OP', op));
        if (op === '<<' || op === '<<-') this.heredocOp = tok;
        continue;
      }

      this.readWord();
    }

    // Input ended while a here-document body was still outstanding.
    if (this.pendingHeredocs.length) {
      throw new IncompleteError(`here-document delimited by '${this.pendingHeredocs[0].delim}'`);
    }

    this.push(new Token('EOF', null));
    return this.tokens;
  }

  skipBlanks() {
    while (this.pos < this.src.length && (this.src[this.pos] === ' ' || this.src[this.pos] === '\t')) {
      this.pos++;
    }
  }

  atWordStart() {
    if (this.pos === 0) return true;
    const prev = this.src[this.pos - 1];
    return ' \t\n;|&()<>'.includes(prev);
  }

  prevCharIsDelimiter() {
    if (this.pos === 0) return true;
    const prev = this.src[this.pos - 1];
    return ' \t\n;|&()'.includes(prev);
  }

  // Scans from an opening delimiter to its match, honouring quotes and nesting.
  scanBalanced(start, open, close) {
    const src = this.src;
    let depth = 0;
    let i = start;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === "'") {
        i++;
        while (i < src.length && src[i] !== "'") i++;
        if (i >= src.length) throw new IncompleteError("unterminated '");
        i++;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') i++;
          i++;
        }
        if (i >= src.length) throw new IncompleteError('unterminated "');
        i++;
        continue;
      }
      if (c === open) { depth++; i++; continue; }
      if (c === close) {
        depth--;
        i++;
        if (depth === 0) return { content: src.slice(start, i), end: i };
        continue;
      }
      i++;
    }
    throw new IncompleteError(`unmatched ${open}`);
  }

  findBacktickEnd(start) {
    let i = start + 1;
    while (i < this.src.length) {
      if (this.src[i] === '\\') { i += 2; continue; }
      if (this.src[i] === '`') return i;
      i++;
    }
    throw new IncompleteError('unterminated `');
  }

  // Inside [[ ]], the word after ==, != or =~ is a pattern or regex, so
  // ( ) | < > belong to it rather than being operators.
  condPatternWord() {
    if (!this.inCond) return false;
    const t = this.last;
    return !!t && t.type === 'WORD' && !t.quoted && ['==', '=', '!=', '=~'].includes(t.value);
  }

  readWord() {
    const parts = [];
    const startPos = this.pos;
    let sawQuote = false;
    const pattern = this.condPatternWord();
    let depth = 0;
    const commandPos = this.atCommandPosition();

    const addLit = (text, q) => {
      const prev = parts[parts.length - 1];
      if (prev && prev.t === 'lit' && prev.q === q) prev.v += text;
      else parts.push({ t: 'lit', v: text, q });
    };

    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (!this.wordMode && !parts.length && (c === '<' || c === '>' || c === '=') && this.src[this.pos + 1] === '('
        && !pattern && (c === '=' || this.pos === startPos)) {
        const { content, end } = this.scanBalanced(this.pos + 1, '(', ')');
        parts.push({ t: 'procsub', dir: c, src: content.slice(1, -1) });
        this.pos = end;
        continue;
      }
      if (!this.wordMode) {
        if (pattern && depth > 0 && (c === ' ' || c === '\t') ) { addLit(c, false); this.pos++; continue; }
        if (c === ' ' || c === '\t' || c === '\n') break;
        if (pattern && (c === '(' || c === '|' || c === '<' || c === '>' || (c === ')' && depth > 0))
          && !this.src.startsWith('||', this.pos)) {
          if (c === '(') depth++;
          if (c === ')') depth--;
          addLit(c, false);
          this.pos++;
          continue;
        }
        // Parentheses in the middle of a word are glob syntax — alternation
        // like src/(a|b).js or qualifiers like *(.) — not a subshell. Not
        // after name= (an array), and not for `name()` (a function).
        if (c === '(' && parts.length && this.src[this.pos + 1] !== ')'
          && !/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(this.src.slice(startPos, this.pos))) {
          const { content, end } = this.scanBalanced(this.pos, '(', ')');
          addLit(content, false);
          this.pos = end;
          continue;
        }
        if (this.matchOperatorAt(this.pos)) break;
      }

      if (c === "'") {
        sawQuote = true;
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) throw new IncompleteError("unterminated '");
        addLit(this.src.slice(this.pos + 1, end), true);
        this.pos = end + 1;
      } else if (c === '"') {
        sawQuote = true;
        this.pos++;
        this.readDoubleQuoted(parts, addLit);
      } else if (c === '$') {
        this.readDollar(parts, false, addLit);
      } else if (c === '`') {
        const end = this.findBacktickEnd(this.pos);
        parts.push({ t: 'cmd', src: this.src.slice(this.pos + 1, end), q: false });
        this.pos = end + 1;
      } else if (c === '\\') {
        const n = this.src[this.pos + 1];
        if (n === undefined) throw new IncompleteError('trailing backslash');
        if (n === '\n') { this.pos += 2; continue; }
        sawQuote = true;
        addLit(n, true);
        this.pos += 2;
      } else {
        addLit(c, false);
        this.pos++;
      }
    }

    if (parts.length === 0 && !sawQuote) {
      this.error(`unexpected character ${JSON.stringify(this.src[this.pos])}`);
    }
    if (parts.length === 0) parts.push({ t: 'lit', v: '', q: true });

    const raw = this.src.slice(startPos, this.pos);
    const reserved = !sawQuote && parts.length === 1 && parts[0].t === 'lit' && RESERVED.has(parts[0].v)
      ? parts[0].v
      : null;
    if (reserved === '[[' && commandPos) this.inCond = true;
    else if (reserved === ']]') this.inCond = false;
    const tok = this.push(new Token('WORD', raw, { parts, quoted: sawQuote, reserved }));

    if (this.heredocOp) {
      const delim = parts.filter((p) => p.t === 'lit').map((p) => p.v).join('');
      this.pendingHeredocs.push({
        delim,
        quoted: sawQuote,
        strip: this.heredocOp.value === '<<-',
        token: this.heredocOp,
      });
      this.heredocOp = null;
    }
    return tok;
  }

  readDoubleQuoted(parts, addLit) {
    for (;;) {
      if (this.pos >= this.src.length) throw new IncompleteError('unterminated "');
      const c = this.src[this.pos];
      if (c === '"') { this.pos++; return; }
      if (c === '\\') {
        const n = this.src[this.pos + 1];
        if (n === '\n') { this.pos += 2; continue; }
        if ('"\\$`'.includes(n)) { addLit(n, true); this.pos += 2; continue; }
        addLit(c, true);
        this.pos++;
        continue;
      }
      if (c === '$') { this.readDollar(parts, true, addLit); continue; }
      if (c === '`') {
        const end = this.findBacktickEnd(this.pos);
        parts.push({ t: 'cmd', src: this.src.slice(this.pos + 1, end), q: true });
        this.pos = end + 1;
        continue;
      }
      addLit(c, true);
      this.pos++;
    }
  }

  readDollar(parts, q, addLit) {
    const src = this.src;
    const p = this.pos + 1;
    const c = src[p];

    if (c === undefined) { addLit('$', q); this.pos = p; return; }

    // $'...' — ANSI-C quoting: backslash escapes, no expansion.
    if (c === "'" && !q) {
      let i = p + 1;
      let raw = '';
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < src.length) { raw += src[i] + src[i + 1]; i += 2; continue; }
        raw += src[i++];
      }
      if (i >= src.length) throw new IncompleteError("unterminated $'");
      addLit(ansiC(raw), true);
      this.pos = i + 1;
      return;
    }

    if (c === '(') {
      if (src[p + 1] === '(') {
        const { content, end } = this.scanBalanced(p, '(', ')');
        parts.push({ t: 'arith', src: content.slice(1, -1), q });
        this.pos = end;
        return;
      }
      const { content, end } = this.scanBalanced(p, '(', ')');
      parts.push({ t: 'cmd', src: content.slice(1, -1), q });
      this.pos = end;
      return;
    }

    if (c === '{') {
      const { content, end } = this.scanBalanced(p, '{', '}');
      parts.push(this.parseParam(content.slice(1, -1), q));
      this.pos = end;
      return;
    }

    if (NAME_START.test(c)) {
      let i = p;
      while (i < src.length && NAME_CHAR.test(src[i])) i++;
      const name = src.slice(p, i);
      this.pos = i;
      const node = { t: 'param', name, q };
      // zsh-style bare subscript: $arr[2]
      if (src[i] === '[') {
        const { content, end } = this.scanBalanced(i, '[', ']');
        this.pos = end;
        node.index = content.slice(1, -1);
        node.bare = content;
      }
      // zsh-style bare modifiers: $file:t, $file:h:h, $name:u
      const mods = [];
      for (;;) {
        const m = /^:([aAehlqQrtuU])(?![A-Za-z0-9_])/.exec(src.slice(this.pos));
        if (!m) break;
        mods.push({ m: m[1] });
        this.pos += m[0].length;
      }
      if (mods.length) node.mods = mods;
      parts.push(node);
      return;
    }

    // $#name: the length of name (zsh).
    if (c === '#' && NAME_START.test(src[p + 1] || '')) {
      let i = p + 1;
      while (i < src.length && NAME_CHAR.test(src[i])) i++;
      parts.push({ t: 'param', name: src.slice(p + 1, i), length: true, flags: [], q });
      this.pos = i;
      return;
    }

    if (SPECIAL_PARAMS.includes(c)) {
      this.pos = p + 1;
      parts.push({ t: 'param', name: c, q });
      return;
    }

    addLit('$', q);
    this.pos = p;
  }

  // ${...}: optional (flags) and =, ~, +, ^, # prefixes; a name, a nested
  // ${...} or $(...), or nothing (${:-word}); a [subscript]; then either
  // :modifiers or one operator with its argument.
  parseParam(content, q) {
    const bad = () => this.error(`bad substitution: \${${content}}`);
    let s = content;
    const node = { t: 'param', q, flags: [], length: false };

    if (s.startsWith('(')) {
      const { flags, rest } = parseFlags(s);
      if (!flags) bad();
      node.flags = flags;
      s = rest;
    }

    for (;;) {
      const c = s[0];
      const nxt = s[1];
      const startsName = nxt !== undefined && /[A-Za-z_0-9@*{$(?!#-]/.test(nxt);
      if (c === '#' && startsName && !(nxt === '}' )) { node.length = true; s = s.slice(1); continue; }
      if (c === '=' && startsName) { node.split = true; s = s.slice(1); continue; }
      if (c === '~' && startsName) { node.globsubst = true; s = s.slice(1); continue; }
      if (c === '+' && startsName) { node.isSet = true; s = s.slice(1); continue; }
      if (c === '^' && startsName) { node.rcexpand = true; s = s.slice(1); continue; }
      break;
    }

    if (s.startsWith('${') || s.startsWith('$(')) {
      const sub = new Lexer(s, { wordMode: true });
      const inner = [];
      sub.readDollar(inner, true, () => bad());
      if (inner.length !== 1) bad();
      node.inner = inner[0];
      s = s.slice(sub.pos);
    } else {
      const m = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(s);
      if (m) {
        node.name = m[1];
        s = s.slice(m[1].length);
      } else if (s === '' || s.startsWith(':') || /^[-=+?]/.test(s)) {
        node.name = '';
      } else bad();
    }

    while (s.startsWith('[')) {
      let depth = 0;
      let i = 0;
      for (; i < s.length; i++) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) bad();
      if (node.index !== undefined) {
        node.subIndex = s.slice(1, i);
      } else node.index = s.slice(1, i);
      s = s.slice(i + 1);
    }

    // :modifiers — letters, as opposed to :offset or :- style operators.
    if (/^:[aAceghlqQrstuUx&]/.test(s)) {
      const { mods, rest } = parseModifiers(s);
      if (mods) { node.mods = mods; s = rest; }
    }

    node.op = null;
    node.argSrc = null;
    if (s.length) {
      const m2 = /^(:[-=+?]|##|#|%%|%|\/\/|\/#|\/%|\/|\^\^|\^|,,|,|:|[-=+?])/.exec(s);
      if (!m2) bad();
      node.op = m2[1];
      node.argSrc = s.slice(node.op.length);
      if (node.op === ':') node.op = ':off';
    }
    return node;
  }

  collectHeredocs() {
    while (this.pendingHeredocs.length) {
      const hd = this.pendingHeredocs.shift();
      const lines = [];
      for (;;) {
        if (this.pos >= this.src.length) {
          throw new IncompleteError(`here-document delimited by '${hd.delim}'`);
        }
        let nl = this.src.indexOf('\n', this.pos);
        if (nl === -1) nl = this.src.length;
        const raw = this.src.slice(this.pos, nl);
        this.pos = Math.min(nl + 1, this.src.length);
        const line = hd.strip ? raw.replace(/^\t+/, '') : raw;
        if (line === hd.delim) break;
        lines.push(line);
      }
      hd.token.heredoc = {
        body: lines.length ? `${lines.join('\n')}\n` : '',
        expand: !hd.quoted,
      };
    }
  }
}

// Backslash escapes of $'...' (and print/echo): \n \t \e \xHH \uHHHH \0NNN …
function ansiC(raw) {
  let r = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { r += raw[i]; continue; }
    const c = raw[++i];
    const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    if (c in simple) { r += simple[c]; continue; }
    let m;
    if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 1)))) { r += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
    if ((c === 'u' || c === 'U') && (m = (c === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(raw.slice(i + 1)))) {
      r += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; continue;
    }
    if (/[0-7]/.test(c)) {
      m = /^[0-7]{1,3}/.exec(raw.slice(i));
      r += String.fromCharCode(parseInt(m[0], 8)); i += m[0].length - 1; continue;
    }
    if (c === 'c' && i + 1 < raw.length) { r += String.fromCharCode(raw.charCodeAt(++i) & 31); continue; }
    r += c === undefined ? '\\' : `\\${c}`;
  }
  return r;
}

// Parameter flags: ${(U)x}, ${(j:,:)arr}, ${(s: :)x}, ${(l:5::0:)n} …
// Flags that take arguments read them between a delimiter of your choice;
// ( [ { < pair with their closers.
const FLAG_ARGS = { j: 1, s: 1, l: 3, r: 3, Z: 1, I: 1, '_': 1 };
const PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
function parseFlags(s) {
  const flags = [];
  let i = 1;
  while (i < s.length && s[i] !== ')') {
    const f = s[i++];
    const want = FLAG_ARGS[f];
    if (!want) { flags.push({ f }); continue; }
    const args = [];
    const open = s[i];
    if (open === undefined) return { flags: null };
    const close = PAIRS[open] || open;
    for (let n = 0; n < want; n++) {
      if (n > 0 && s[i] !== open) break;
      i++;
      const end = s.indexOf(close, i);
      if (end === -1) return { flags: null };
      args.push(s.slice(i, end));
      i = end;
      if (n + 1 < want && s[i + 1] === open) { i++; continue; }
      i++;
      break;
    }
    // After the loop i sits just past the closing delimiter.
    if (s[i - 1] !== close) i++;
    flags.push({ f, args });
  }
  if (s[i] !== ')') return { flags: null };
  return { flags, rest: s.slice(i + 1) };
}

// History-style modifiers: :h :t :r :e :a :A :l :u :q :Q :s/old/new/ :gs/…/…/ :&
function parseModifiers(s) {
  const mods = [];
  let i = 0;
  while (s[i] === ':') {
    let j = i + 1;
    let global = false;
    if (s[j] === 'g' && /[s&]/.test(s[j + 1] || '')) { global = true; j++; }
    const m = s[j];
    if (!m || !/[aAceghlqQrstuUx&]/.test(m)) break;
    j++;
    if (m === 's') {
      const d = s[j];
      if (!d) return { mods: null };
      const end1 = s.indexOf(d, j + 1);
      if (end1 === -1) return { mods: null };
      let end2 = s.indexOf(d, end1 + 1);
      const from = s.slice(j + 1, end1);
      const to = s.slice(end1 + 1, end2 === -1 ? s.length : end2);
      mods.push({ m: 's', from, to, global });
      i = end2 === -1 ? s.length : end2 + 1;
      continue;
    }
    const count = /^\d+/.exec(s.slice(j));
    if (count && (m === 'h' || m === 't')) { j += count[0].length; mods.push({ m, n: Number(count[0]) }); } else mods.push({ m, global });
    i = j;
  }
  if (!mods.length) return { mods: null };
  return { mods, rest: s.slice(i) };
}

// Parses a fragment of shell source as the guts of a single word, so things
// like `${x:-$HOME/bin}` can reuse the same expansion machinery.
function lexWordParts(src) {
  if (src === '') return [];
  const lx = new Lexer(src, { wordMode: true });
  lx.readWord();
  return lx.tokens[0].parts;
}

// A here-document body expands like the inside of a double-quoted string.
function lexHeredocParts(body) {
  const lx = new Lexer(`${body.replace(/"/g, '\\"')}"`, { wordMode: true });
  const parts = [];
  const addLit = (text, q) => {
    const prev = parts[parts.length - 1];
    if (prev && prev.t === 'lit' && prev.q === q) prev.v += text;
    else parts.push({ t: 'lit', v: text, q });
  };
  lx.readDoubleQuoted(parts, addLit);
  return parts;
}

module.exports = {
  Lexer,
  Token,
  ShellError,
  IncompleteError,
  lexWordParts,
  lexHeredocParts,
  ansiC,
  RESERVED,
  REDIR_OPS,
};
