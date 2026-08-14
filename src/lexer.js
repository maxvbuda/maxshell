'use strict';

const KEYWORDS = new Set([
  'let', 'fn', 'do', 'end', 'if', 'else', 'while', 'print', 'return',
  'true', 'false', 'and', 'or', 'not', 'cd', 'exit', 'pwd',
]);

class Token {
  constructor(type, value, line) {
    this.type = type;
    this.value = value;
    this.line = line;
  }
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch) {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

class Lexer {
  constructor(source) {
    this.src = source;
    this.pos = 0;
    this.line = 1;
    this.tokens = [];
  }

  peek(offset = 0) {
    return this.src[this.pos + offset];
  }

  advance() {
    const ch = this.src[this.pos++];
    if (ch === '\n') this.line++;
    return ch;
  }

  push(type, value) {
    this.tokens.push(new Token(type, value, this.line));
  }

  tokenize() {
    while (this.pos < this.src.length) {
      const ch = this.peek();

      if (ch === '#') {
        while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
        continue;
      }

      if (ch === '\n') {
        this.advance();
        this.push('NEWLINE', '\n');
        continue;
      }

      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.advance();
        continue;
      }

      // Shell escape: "!" runs the rest of the physical line as a real
      // system command through the host shell (pipes, redirects, etc.
      // all work exactly as in a normal terminal).
      if (ch === '!') {
        this.advance();
        let cmd = '';
        while (this.pos < this.src.length && this.peek() !== '\n') {
          cmd += this.advance();
        }
        this.push('SHELL', cmd.trim());
        continue;
      }

      if (isDigit(ch)) {
        let num = '';
        while (this.pos < this.src.length && (isDigit(this.peek()) || this.peek() === '.')) {
          num += this.advance();
        }
        this.push('NUMBER', parseFloat(num));
        continue;
      }

      if (ch === '"' || ch === "'") {
        const quote = this.advance();
        let str = '';
        while (this.pos < this.src.length && this.peek() !== quote) {
          let c = this.advance();
          if (c === '\\' && this.pos < this.src.length) {
            const next = this.advance();
            const escapes = { n: '\n', t: '\t', '"': '"', "'": "'", '\\': '\\' };
            c = escapes[next] !== undefined ? escapes[next] : next;
          }
          str += c;
        }
        if (this.peek() === quote) this.advance();
        this.push('STRING', str);
        continue;
      }

      if (isIdentStart(ch)) {
        let id = '';
        while (this.pos < this.src.length && isIdentPart(this.peek())) {
          id += this.advance();
        }
        this.push(KEYWORDS.has(id) ? id.toUpperCase() : 'IDENT', id);
        continue;
      }

      // Two-char operators
      const two = ch + (this.peek(1) || '');
      if (['==', '!=', '<=', '>='].includes(two)) {
        this.advance(); this.advance();
        this.push(two, two);
        continue;
      }

      const singles = {
        '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH', '%': 'PERCENT',
        '=': 'EQ', '<': 'LT', '>': 'GT', '(': 'LPAREN', ')': 'RPAREN',
        ',': 'COMMA',
      };
      if (singles[ch]) {
        this.advance();
        this.push(singles[ch], ch);
        continue;
      }

      throw new Error(`Unexpected character '${ch}' on line ${this.line}`);
    }
    this.push('EOF', null);
    return this.tokens;
  }
}

module.exports = { Lexer, Token };
