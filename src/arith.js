'use strict';

const { ShellError } = require('./lexer');

const OPS3 = ['<<=', '>>=', '**='];
const OPS2 = ['**', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=', '**=']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    if (c === '$') {
      if (src[i + 1] === '{') {
        const close = src.indexOf('}', i);
        if (close === -1) throw new ShellError('bad arithmetic expression');
        toks.push({ t: 'name', v: src.slice(i + 2, close) });
        i = close + 1;
        continue;
      }
      // $1, $name, $# and friends name a parameter, not a literal number.
      const ref = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/.exec(src.slice(i + 1));
      if (ref) {
        toks.push({ t: 'name', v: ref[1] });
        i += 1 + ref[1].length;
        continue;
      }
      i++;
      continue;
    }

    if (/[0-9]/.test(c)) {
      const rest = src.slice(i);
      const m = /^0[xX][0-9a-fA-F]+/.exec(rest)
        || /^\d+\.\d+([eE][-+]?\d+)?/.exec(rest)
        || /^\d+/.exec(rest);
      toks.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }

    const three = OPS3.find((o) => src.startsWith(o, i));
    if (three) { toks.push({ t: 'op', v: three }); i += 3; continue; }
    const two = OPS2.find((o) => src.startsWith(o, i));
    if (two) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%()<>!~&|^?:,='.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }

    throw new ShellError(`bad arithmetic expression near '${src.slice(i)}'`);
  }
  toks.push({ t: 'eof', v: null });
  return toks;
}

function toInt(n) {
  return n | 0;
}

function applyBinary(op, a, b) {
  const intish = Number.isInteger(a) && Number.isInteger(b);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/':
      if (b === 0) throw new ShellError('division by zero');
      return intish ? Math.trunc(a / b) : a / b;
    case '%':
      if (b === 0) throw new ShellError('division by zero');
      return intish ? a % b : a % b;
    case '**': return a ** b;
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '&': return toInt(a) & toInt(b);
    case '|': return toInt(a) | toInt(b);
    case '^': return toInt(a) ^ toInt(b);
    case '<<': return toInt(a) << toInt(b);
    case '>>': return toInt(a) >> toInt(b);
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
  constructor(toks, shell) {
    this.toks = toks;
    this.i = 0;
    this.shell = shell;
  }

  peek(k = 0) { return this.toks[this.i + k]; }

  isOp(v) { const t = this.peek(); return t.t === 'op' && t.v === v; }

  eat(v) { if (this.isOp(v)) { this.i++; return true; } return false; }

  expect(v) { if (!this.eat(v)) throw new ShellError(`arithmetic: expected '${v}'`); }

  get(name) {
    const raw = this.shell.getVar(name);
    if (raw === undefined || raw === '') return 0;
    const n = Number(raw);
    return Number.isNaN(n) ? 0 : n;
  }

  set(name, value) {
    this.shell.setVar(name, String(value));
    return value;
  }

  parse() {
    const v = this.parseComma();
    if (this.peek().t !== 'eof') throw new ShellError('arithmetic: unexpected trailing input');
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
      const rhs = this.parseAssign();
      const value = nx.v === '=' ? rhs : applyBinary(nx.v.slice(0, -1), this.get(t.v), rhs);
      return this.set(t.v, value);
    }
    return this.parseTernary();
  }

  parseTernary() {
    const cond = this.parseLogicalOr();
    if (!this.eat('?')) return cond;
    const a = this.parseAssign();
    this.expect(':');
    const b = this.parseAssign();
    return cond ? a : b;
  }

  parseLogicalOr() {
    let left = this.parseLogicalAnd();
    while (this.eat('||')) {
      const right = this.parseLogicalAnd();
      left = (left || right) ? 1 : 0;
    }
    return left;
  }

  parseLogicalAnd() {
    let left = this.parseBinary(0);
    while (this.eat('&&')) {
      const right = this.parseBinary(0);
      left = (left && right) ? 1 : 0;
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
      left = applyBinary(t.v, left, this.parseBinary(level + 1));
    }
  }

  parseUnary() {
    if (this.eat('!')) return this.parseUnary() ? 0 : 1;
    if (this.eat('~')) return ~toInt(this.parseUnary());
    if (this.eat('-')) return -this.parseUnary();
    if (this.eat('+')) return +this.parseUnary();
    if (this.isOp('++') || this.isOp('--')) {
      const op = this.peek().v;
      this.i++;
      const t = this.peek();
      if (t.t !== 'name') throw new ShellError(`arithmetic: '${op}' needs a variable`);
      this.i++;
      return this.set(t.v, this.get(t.v) + (op === '++' ? 1 : -1));
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    if (this.eat('**')) return base ** this.parseUnary();
    return base;
  }

  parsePostfix() {
    const v = this.parsePrimary();
    const t = this.peek();
    if (t.t === 'op' && (t.v === '++' || t.v === '--') && this.lastName) {
      this.i++;
      const name = this.lastName;
      this.set(name, this.get(name) + (t.v === '++' ? 1 : -1));
      return v;
    }
    return v;
  }

  parsePrimary() {
    this.lastName = null;
    const t = this.peek();
    if (t.t === 'num') { this.i++; return t.v; }
    if (t.t === 'name') { this.i++; this.lastName = t.v; return this.get(t.v); }
    if (this.eat('(')) {
      const v = this.parseComma();
      this.expect(')');
      return v;
    }
    throw new ShellError(`arithmetic: unexpected ${t.v === null ? 'end of expression' : `'${t.v}'`}`);
  }
}

function evalArith(src, shell) {
  return new ArithParser(tokenize(src), shell).parse();
}

module.exports = { evalArith };
