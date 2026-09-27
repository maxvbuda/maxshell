'use strict';

const { ShellError } = require('./lexer');

// Shell arithmetic, as in zsh: 64-bit integers (BigInt, wrapped to 64 bits)
// and floating point when a float is involved. `&&`, `||` and `?:` only
// evaluate the side they need, so `(( x && y++ ))` behaves.

const OPS3 = ['<<=', '>>=', '**=', '&&=', '||=', '^^='];
const OPS2 = ['**', '==', '!=', '<=', '>=', '&&', '||', '^^', '<<', '>>', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=', '**=', '&&=', '||=', '^^=']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    if (c === '$') {
      // $#name is the length of name.
      const len = /^#([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i + 1));
      if (len) { toks.push({ t: 'len', v: len[1] }); i += 1 + len[0].length; continue; }
      // $1, $name, $# and friends name a parameter, not a literal number.
      const ref = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(src.slice(i + 1));
      if (ref) {
        i += 1 + ref[1].length;
        toks.push(readSubscript({ t: 'name', v: ref[1] }));
        continue;
      }
      i++;
      continue;
    }

    if (/[0-9.]/.test(c) && /^\.?\d/.test(src.slice(i))) {
      const rest = src.slice(i);
      // base#digits, e.g. 2#101, 16#ff, 36#zz
      const based = /^(\d+)#([0-9a-zA-Z@_]+)/.exec(rest);
      if (based) {
        const base = Number(based[1]);
        if (base < 2 || base > 36) throw new ShellError(`invalid base: ${base}`);
        let n = 0n;
        for (const ch of based[2].toLowerCase()) {
          const d = parseInt(ch, 36);
          if (Number.isNaN(d) || d >= base) throw new ShellError(`bad math expression: ${based[0]}`);
          n = n * BigInt(base) + BigInt(d);
        }
        toks.push({ t: 'num', v: wrap(n) });
        i += based[0].length;
        continue;
      }
      let m = /^0[xX][0-9a-fA-F]+/.exec(rest);
      if (m) { toks.push({ t: 'num', v: wrap(BigInt(m[0])) }); i += m[0].length; continue; }
      m = /^0[bB][01]+/.exec(rest);
      if (m) { toks.push({ t: 'num', v: wrap(BigInt(m[0])) }); i += m[0].length; continue; }
      m = /^(\d+\.\d*|\.\d+)([eE][-+]?\d+)?|^\d+[eE][-+]?\d+/.exec(rest);
      if (m) { toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
      m = /^\d+/.exec(rest);
      toks.push({ t: 'num', v: wrap(BigInt(m[0])) });
      i += m[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      i += m[0].length;
      toks.push(readSubscript({ t: 'name', v: m[0] }));
      continue;
    }

    if (c === '#' && /^#[A-Za-z_]/.test(src.slice(i))) {
      const m = /^#([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      toks.push({ t: 'len', v: m[1] });
      i += m[0].length;
      continue;
    }

    const three = OPS3.find((o) => src.startsWith(o, i));
    if (three) { toks.push({ t: 'op', v: three }); i += 3; continue; }
    const two = OPS2.find((o) => src.startsWith(o, i));
    if (two) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%()<>!~&|^?:,='.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }

    throw new ShellError(`bad math expression: illegal character: ${c}`);
  }
  toks.push({ t: 'eof', v: null });
  return toks;

  // name[subscript] — an array element.
  function readSubscript(tok) {
    if (src[i] !== '[') return tok;
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === '[') depth++;
      else if (src[j] === ']') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new ShellError('bad math expression: unbalanced [');
    tok.index = src.slice(i + 1, j);
    i = j + 1;
    return tok;
  }
}

const wrap = (n) => BigInt.asIntN(64, n);
const isFloat = (x) => typeof x === 'number';
const truthy = (x) => (isFloat(x) ? x !== 0 : x !== 0n);
const bool = (b) => (b ? 1n : 0n);

function toBig(x) {
  if (typeof x === 'bigint') return x;
  if (!Number.isFinite(x)) return 0n;
  return wrap(BigInt(Math.trunc(x)));
}

function applyBinary(op, a, b) {
  const float = isFloat(a) || isFloat(b);
  if (float && '+-*/%**<<=>>===!='.includes(op) && !['<<', '>>'].includes(op)) {
    const x = Number(a);
    const y = Number(b);
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': if (y === 0) throw new ShellError('division by zero'); return x / y;
      case '%': if (y === 0) throw new ShellError('division by zero'); return x % y;
      case '**': return x ** y;
      case '<': return bool(x < y);
      case '<=': return bool(x <= y);
      case '>': return bool(x > y);
      case '>=': return bool(x >= y);
      case '==': return bool(x === y);
      case '!=': return bool(x !== y);
      default: break;
    }
  }
  const x = toBig(a);
  const y = toBig(b);
  switch (op) {
    case '+': return wrap(x + y);
    case '-': return wrap(x - y);
    case '*': return wrap(x * y);
    case '/': if (y === 0n) throw new ShellError('division by zero'); return wrap(x / y);
    case '%': if (y === 0n) throw new ShellError('division by zero'); return wrap(x % y);
    case '**':
      if (y < 0n) return Number(x) ** Number(y);
      return wrap(x ** y);
    case '<': return bool(x < y);
    case '<=': return bool(x <= y);
    case '>': return bool(x > y);
    case '>=': return bool(x >= y);
    case '==': return bool(x === y);
    case '!=': return bool(x !== y);
    case '&': return wrap(x & y);
    case '|': return wrap(x | y);
    case '^': return wrap(x ^ y);
    case '<<': return wrap(x << (y & 63n));
    case '>>': return wrap(x >> (y & 63n));
    default: throw new ShellError(`unknown arithmetic operator '${op}'`);
  }
}

const LEVELS = [
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

class ArithParser {
  constructor(toks, shell, depth) {
    this.toks = toks;
    this.i = 0;
    this.shell = shell;
    this.depth = depth;
    // While > 0 we're on the side of && || ?: that isn't taken: parse, but
    // don't assign or complain about division by zero.
    this.skip = 0;
  }

  peek(k = 0) { return this.toks[this.i + k]; }

  isOp(v) { const t = this.peek(); return t.t === 'op' && t.v === v; }

  eat(v) { if (this.isOp(v)) { this.i++; return true; } return false; }

  expect(v) { if (!this.eat(v)) throw new ShellError(`bad math expression: expected '${v}'`); }

  // A variable's value as a number. Values that are themselves expressions
  // are evaluated, as in zsh (x=1+2; $((x*2)) is 6).
  get(tok) {
    if (!this.shell) return 0n;
    let raw;
    if (tok.index !== undefined) raw = this.element(tok.v, tok.index);
    else raw = this.shell.getVar(tok.v);
    if (raw === undefined || raw === '') return 0n;
    const s = String(raw).trim();
    if (/^-?\d+$/.test(s)) return wrap(BigInt(s));
    if (/^-?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
    if (this.depth > 50) throw new ShellError(`${tok.v}: maximum nested expression depth reached`);
    return evalValue(s, this.shell, this.depth + 1);
  }

  element(name, index) {
    const entry = this.shell.findEntry(name);
    if (entry && entry.value instanceof Map) {
      const { lexWordParts } = require('./lexer');
      const { expandToString } = require('./expand');
      return entry.value.get(expandToString(this.shell, lexWordParts(index)));
    }
    const arr = this.shell.getArray(name) || (this.shell.getVar(name) !== undefined ? [this.shell.getVar(name)] : []);
    const n = Number(evalValue(index, this.shell, this.depth + 1));
    return n < 0 ? arr[arr.length + n] : arr[n - 1];
  }

  set(tok, value) {
    if (this.skip || !this.shell) return value;
    const text = formatValue(value);
    if (tok.index !== undefined) {
      this.shell.doAssign({ name: tok.v, index: tok.index, append: false, value: { parts: [{ t: 'lit', v: text, q: true }] } });
    } else this.shell.setVar(tok.v, text);
    return value;
  }

  parse() {
    const v = this.parseComma();
    if (this.peek().t !== 'eof') {
      const t = this.peek();
      throw new ShellError(`bad math expression: operator expected at '${t.v ?? ''}'`);
    }
    return v;
  }

  parseComma() {
    let v = this.parseAssign();
    while (this.eat(',')) v = this.parseAssign();
    return v;
  }

  parseAssign() {
    const t = this.peek();
    const nx = this.peek(1);
    if (t.t === 'name' && nx && nx.t === 'op' && ASSIGN_OPS.has(nx.v)) {
      this.i += 2;
      if (nx.v === '&&=' || nx.v === '||=' || nx.v === '^^=') {
        const cur = truthy(this.get(t));
        const rhs = this.parseAssign();
        const r = nx.v === '&&=' ? cur && truthy(rhs) : nx.v === '||=' ? cur || truthy(rhs) : cur !== truthy(rhs);
        return this.set(t, bool(r));
      }
      const rhs = this.parseAssign();
      let value = rhs;
      if (nx.v !== '=') value = this.safe(() => applyBinary(nx.v.slice(0, -1), this.get(t), rhs));
      return this.set(t, value);
    }
    return this.parseTernary();
  }

  // Division by zero on a branch that isn't taken is not an error.
  safe(fn) {
    try { return fn(); } catch (e) { if (this.skip) return 0n; throw e; }
  }

  parseTernary() {
    const cond = this.parseLogicalOr();
    if (!this.eat('?')) return cond;
    const take = truthy(cond);
    if (!take) this.skip++;
    const a = this.parseAssign();
    if (!take) this.skip--;
    this.expect(':');
    if (take) this.skip++;
    const b = this.parseAssign();
    if (take) this.skip--;
    return take ? a : b;
  }

  parseLogicalOr() {
    let left = this.parseLogicalXor();
    while (this.eat('||')) {
      const done = truthy(left);
      if (done) this.skip++;
      const right = this.parseLogicalXor();
      if (done) this.skip--;
      left = bool(done || truthy(right));
    }
    return left;
  }

  parseLogicalXor() {
    let left = this.parseLogicalAnd();
    while (this.eat('^^')) left = bool(truthy(left) !== truthy(this.parseLogicalAnd()));
    return left;
  }

  parseLogicalAnd() {
    let left = this.parseBinary(0);
    while (this.eat('&&')) {
      const done = !truthy(left);
      if (done) this.skip++;
      const right = this.parseBinary(0);
      if (done) this.skip--;
      left = bool(!done && truthy(right));
    }
    return left;
  }

  parseBinary(level) {
    if (level >= LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !LEVELS[level].includes(t.v)) return left;
      this.i++;
      const right = this.parseBinary(level + 1);
      const l = left;
      left = this.safe(() => applyBinary(t.v, l, right));
    }
  }

  parseUnary() {
    if (this.eat('!')) return bool(!truthy(this.parseUnary()));
    if (this.eat('~')) return wrap(~toBig(this.parseUnary()));
    if (this.eat('-')) { const v = this.parseUnary(); return isFloat(v) ? -v : wrap(-v); }
    if (this.eat('+')) return this.parseUnary();
    if (this.isOp('++') || this.isOp('--')) {
      const op = this.peek().v;
      this.i++;
      const t = this.peek();
      if (t.t !== 'name') throw new ShellError(`bad math expression: '${op}' needs a variable`);
      this.i++;
      return this.set(t, applyBinary(op === '++' ? '+' : '-', this.get(t), 1n));
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    if (this.eat('**')) { const e = this.parseUnary(); return this.safe(() => applyBinary('**', base, e)); }
    return base;
  }

  parsePostfix() {
    const t = this.peek();
    const v = this.parsePrimary();
    const nx = this.peek();
    if (t.t === 'name' && nx.t === 'op' && (nx.v === '++' || nx.v === '--')) {
      this.i++;
      this.set(t, applyBinary(nx.v === '++' ? '+' : '-', v, 1n));
      return v;
    }
    return v;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.t === 'num') { this.i++; return t.v; }
    if (t.t === 'name') { this.i++; return this.get(t); }
    if (t.t === 'len') {
      this.i++;
      const arr = this.shell && this.shell.getArray(t.v);
      return BigInt(arr ? arr.length : [...(this.shell ? this.shell.getVar(t.v) ?? '' : '')].length);
    }
    if (this.eat('(')) {
      const v = this.parseComma();
      this.expect(')');
      return v;
    }
    if (t.t === 'eof') throw new ShellError('bad math expression: operand expected at end of string');
    throw new ShellError(`bad math expression: operand expected at '${t.v}'`);
  }
}

// zsh prints whole floats with a trailing dot (2.) so they stay floats.
function formatValue(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Inf' : '-Inf';
  if (Number.isInteger(v)) return `${v}.`;
  return String(Number(v.toPrecision(15)));
}

function evalValue(src, shell, depth = 0) {
  // $(...), ${...} and `...` are expanded first, as inside double quotes;
  // plain $name is left for the evaluator.
  if (shell && /\$[({]|`/.test(src)) {
    const { lexHeredocParts } = require('./lexer');
    const { expandToString } = require('./expand');
    src = expandToString(shell, lexHeredocParts(src));
  }
  if (!src.trim()) return 0n;
  return new ArithParser(tokenize(src), shell, depth).parse();
}

// The result as a JavaScript number, for callers that count or index.
function evalArith(src, shell) {
  return Number(evalValue(src, shell));
}

// The result as the shell prints it, for $((...)).
function evalArithString(src, shell) {
  return formatValue(evalValue(src, shell));
}

module.exports = { evalArith, evalArithString, evalValue, formatValue };
