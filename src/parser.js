'use strict';

const { Lexer } = require('./lexer');

class Parser {
  constructor(source) {
    this.tokens = new Lexer(source).tokenize();
    this.pos = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.pos + offset];
  }

  at(type) {
    return this.peek().type === type;
  }

  advance() {
    return this.tokens[this.pos++];
  }

  expect(type) {
    if (!this.at(type)) {
      const tok = this.peek();
      throw new Error(`Expected ${type} but got ${tok.type} on line ${tok.line}`);
    }
    return this.advance();
  }

  skipNewlines() {
    while (this.at('NEWLINE')) this.advance();
  }

  skipTerminators() {
    while (this.at('NEWLINE')) this.advance();
  }

  parseProgram() {
    const body = [];
    this.skipNewlines();
    while (!this.at('EOF')) {
      body.push(this.parseStatement());
      this.skipTerminators();
    }
    return { type: 'Program', body };
  }

  parseStatementsUntil(enders) {
    const body = [];
    while (!enders.includes(this.peek().type) && !this.at('EOF')) {
      body.push(this.parseStatement());
      this.skipTerminators();
    }
    return body;
  }

  parseBlock() {
    this.expect('DO');
    this.skipNewlines();
    return this.parseStatementsUntil(['END']);
  }

  parseStatement() {
    switch (this.peek().type) {
      case 'SHELL': {
        const tok = this.advance();
        return { type: 'ShellExec', command: tok.value };
      }
      case 'LET': {
        this.advance();
        const name = this.expect('IDENT').value;
        this.expect('EQ');
        const value = this.parseExpression();
        return { type: 'LetDecl', name, value };
      }
      case 'PRINT': {
        this.advance();
        const value = this.parseExpression();
        return { type: 'Print', value };
      }
      case 'RETURN': {
        this.advance();
        if (this.at('NEWLINE') || this.at('END') || this.at('EOF')) {
          return { type: 'Return', value: null };
        }
        return { type: 'Return', value: this.parseExpression() };
      }
      case 'IF': {
        this.advance();
        const test = this.parseExpression();
        this.expect('DO');
        this.skipNewlines();
        const consequent = this.parseStatementsUntil(['END', 'ELSE']);
        let alternate = [];
        if (this.at('ELSE')) {
          this.advance();
          this.skipNewlines();
          if (this.at('IF')) {
            // "else if ..." — the nested if consumes its own trailing "end".
            return { type: 'If', test, consequent, alternate: [this.parseStatement()] };
          }
          alternate = this.parseStatementsUntil(['END']);
        }
        this.expect('END');
        return { type: 'If', test, consequent, alternate };
      }
      case 'WHILE': {
        this.advance();
        const test = this.parseExpression();
        const body = this.parseBlock();
        this.expect('END');
        return { type: 'While', test, body };
      }
      case 'FN': {
        this.advance();
        const name = this.expect('IDENT').value;
        this.expect('LPAREN');
        const params = [];
        if (!this.at('RPAREN')) {
          params.push(this.expect('IDENT').value);
          while (this.at('COMMA')) {
            this.advance();
            params.push(this.expect('IDENT').value);
          }
        }
        this.expect('RPAREN');
        const body = this.parseBlock();
        this.expect('END');
        return { type: 'FnDecl', name, params, body };
      }
      case 'CD': {
        const tok = this.advance();
        return { type: 'Cd', target: tok.value || null };
      }
      case 'PWD': {
        this.advance();
        return { type: 'Pwd' };
      }
      case 'EXIT': {
        this.advance();
        return { type: 'Exit' };
      }
      default: {
        const expr = this.parseExpression();
        return { type: 'ExprStatement', expr };
      }
    }
  }

  // Expression parsing, lowest to highest precedence.
  parseExpression() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.at('OR')) {
      this.advance();
      left = { type: 'Logical', op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.at('AND')) {
      this.advance();
      left = { type: 'Logical', op: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  parseNot() {
    if (this.at('NOT')) {
      this.advance();
      return { type: 'Unary', op: 'not', argument: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseAdditive();
    const ops = { '==': '==', '!=': '!=', '<=': '<=', '>=': '>=', LT: '<', GT: '>' };
    while (Object.prototype.hasOwnProperty.call(ops, this.peek().type)) {
      const opTok = this.advance();
      const op = ops[opTok.type];
      left = { type: 'Binary', op, left, right: this.parseAdditive() };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.at('PLUS') || this.at('MINUS')) {
      const op = this.advance().type === 'PLUS' ? '+' : '-';
      left = { type: 'Binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.at('STAR') || this.at('SLASH') || this.at('PERCENT')) {
      const t = this.advance().type;
      const op = t === 'STAR' ? '*' : t === 'SLASH' ? '/' : '%';
      left = { type: 'Binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    if (this.at('MINUS')) {
      this.advance();
      return { type: 'Unary', op: '-', argument: this.parseUnary() };
    }
    return this.parseCall();
  }

  parseCall() {
    let expr = this.parsePrimary();
    while (this.at('LPAREN')) {
      this.advance();
      const args = [];
      if (!this.at('RPAREN')) {
        args.push(this.parseExpression());
        while (this.at('COMMA')) {
          this.advance();
          args.push(this.parseExpression());
        }
      }
      this.expect('RPAREN');
      expr = { type: 'Call', callee: expr, args };
    }
    return expr;
  }

  parsePrimary() {
    const tok = this.peek();
    if (tok.type === 'NUMBER') {
      this.advance();
      return { type: 'NumberLit', value: tok.value };
    }
    if (tok.type === 'STRING') {
      this.advance();
      return { type: 'StringLit', value: tok.value };
    }
    if (tok.type === 'TRUE') {
      this.advance();
      return { type: 'BoolLit', value: true };
    }
    if (tok.type === 'FALSE') {
      this.advance();
      return { type: 'BoolLit', value: false };
    }
    if (tok.type === 'IDENT') {
      this.advance();
      return { type: 'Identifier', name: tok.value };
    }
    if (tok.type === 'LPAREN') {
      this.advance();
      const expr = this.parseExpression();
      this.expect('RPAREN');
      return expr;
    }
    throw new Error(`Unexpected token ${tok.type} on line ${tok.line}`);
  }
}

module.exports = { Parser };
