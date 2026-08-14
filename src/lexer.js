'use strict';

const KEYWORDS = new Set([
  'let', 'fn', 'do', 'end', 'if', 'else', 'while', 'print', 'return',
  'true', 'false', 'and', 'or', 'not', 'cd', 'exit', 'pwd', 'help',
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

// A bare line that looks like a call to a MaxScript function the user
// defined, e.g. `greet("world")` — parsed as MaxScript, not run as a
// command, so top-level function calls work without any prefix.
const CALL_LINE_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*\(.*\)\s*$/;

class Lexer {
  constructor(source) {
    this.src = source;
    this.pos = 0;
    this.line = 1;
    this.tokens = [];
    // True at the first character of each physical line, so we get one
    // shot per line to decide "is this MaxScript or a real command?".
    this.atLineStart = true;
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

  // Like a real terminal: a line is only MaxScript if it starts with a
  // MaxScript keyword or is a call to a function you defined. Anything
  // else — `ls`, `git status`, `cd ..`, `./script.sh` — runs directly as
  // a real system command, no "!" needed. Returns true if it consumed
  // the whole line itself (as a SHELL token).
  classifyLine() {
    let end = this.src.indexOf('\n', this.pos);
    if (end === -1) end = this.src.length;
    const lineText = this.src.slice(this.pos, end);
    const trimmed = lineText.trim();
    if (trimmed === '' || trimmed[0] === '#' || trimmed[0] === '!') {
      return false;
    }
    const firstWord = (trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*/) || [])[0];
    if (firstWord && KEYWORDS.has(firstWord)) {
      return false;
    }
    if (CALL_LINE_RE.test(trimmed)) {
      return false;
    }
    this.pos += lineText.length;
    this.push('SHELL', trimmed);
    return true;
  }

  tokenize() {
    while (this.pos < this.src.length) {
      const ch = this.peek();

      if (this.atLineStart && ch !== '\n') {
        this.atLineStart = false;
        if (this.classifyLine()) continue;
      }

      if (ch === '#') {
        while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
        continue;
      }

      if (ch === '\n') {
        this.advance();
        this.push('NEWLINE', '\n');
        this.atLineStart = true;
        continue;
      }

      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.advance();
        continue;
      }

      // Explicit shell escape: "!" runs the rest of the physical line as
      // a real system command. Bare commands already run without it (see
      // classifyLine); this remains for disambiguation when needed.
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
        if (id === 'cd') {
          // Paths ("..", "../foo", "~", "some-dir") aren't valid MaxScript
          // expressions, so take the rest of the line as raw text instead
          // of tokenizing it, the same way "!" and bare commands do.
          let arg = '';
          while (this.pos < this.src.length && this.peek() !== '\n') {
            arg += this.advance();
          }
          this.push('CD', arg.trim());
          continue;
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
