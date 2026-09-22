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
  '&&', '||', ';;', ';&', '>>', '<<', '>&', '<&', '&>', '|&',
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
  }

  error(msg) {
    throw new ShellError(msg);
  }

  get last() {
    return this.tokens[this.tokens.length - 1];
  }

  push(tok) {
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

  readWord() {
    const parts = [];
    const startPos = this.pos;
    let sawQuote = false;

    const addLit = (text, q) => {
      const prev = parts[parts.length - 1];
      if (prev && prev.t === 'lit' && prev.q === q) prev.v += text;
      else parts.push({ t: 'lit', v: text, q });
    };

    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (!this.wordMode) {
        if (c === ' ' || c === '\t' || c === '\n') break;
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
      // zsh-style bare subscript: $arr[2]
      if (src[i] === '[') {
        const { content, end } = this.scanBalanced(i, '[', ']');
        this.pos = end;
        parts.push({ t: 'param', name, index: content.slice(1, -1), bare: content, q });
        return;
      }
      parts.push({ t: 'param', name, q });
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

  parseParam(content, q) {
    let s = content;
    let length = false;
    if (s.startsWith('#') && s.length > 1) { length = true; s = s.slice(1); }

    const m = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(s);
    if (!m) this.error(`bad substitution: \${${content}}`);
    const name = m[1];
    s = s.slice(name.length);

    let index = null;
    if (s.startsWith('[')) {
      let depth = 0;
      let i = 0;
      for (; i < s.length; i++) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) this.error(`bad substitution: \${${content}}`);
      index = s.slice(1, i);
      s = s.slice(i + 1);
    }

    let op = null;
    let argSrc = null;
    if (s.length) {
      const m2 = /^(:[-=+?]|##|#|%%|%|\/\/|\/#|\/%|\/|:|[-=+?])/.exec(s);
      if (!m2) this.error(`bad substitution: \${${content}}`);
      op = m2[1];
      argSrc = s.slice(op.length);
      if (op === ':') op = ':off';
    }

    return { t: 'param', name, index, length, op, argSrc, q };
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
  RESERVED,
  REDIR_OPS,
};
