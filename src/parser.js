'use strict';

const {
  Lexer, ShellError, IncompleteError, REDIR_OPS, lexWordParts,
} = require('./lexer');

// Reserved words that terminate a command list. They are only recognised in
// command position, so `echo done` still prints "done".
const CLOSERS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}', ']]', 'in', 'end']);

// Builtins whose name=value arguments are assignments.
const DECLARERS = new Set(['typeset', 'declare', 'local', 'export', 'readonly', 'integer', 'float']);

const COND_UNARY = new Set([
  '-e', '-f', '-d', '-r', '-w', '-x', '-s', '-z', '-n', '-L', '-h',
  '-b', '-c', '-p', '-S', '-t', '-o', '-v', '-G', '-O', '-N', '-a',
]);
const COND_BINARY = new Set([
  '=', '==', '!=', '=~', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-ef', '-nt', '-ot',
]);

function wordText(tok) {
  return tok.parts.filter((p) => p.t === 'lit').map((p) => p.v).join('');
}

function splitAssignment(word) {
  const p0 = word.parts[0];
  if (!p0 || p0.t !== 'lit' || p0.q) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/.exec(p0.v);
  if (!m) return splitSubscriptAssignment(word);
  const rest = p0.v.slice(m[0].length);
  const valueParts = (rest ? [{ t: 'lit', v: rest, q: false }] : []).concat(word.parts.slice(1));
  return {
    name: m[1],
    index: m[2] ? m[2].slice(1, -1) : null,
    append: m[3] === '+',
    value: { parts: valueParts },
    array: null,
  };
}

// name[...]=value where the subscript holds expansions or quotes, like
// h[$key]=v or h["a b"]=v: found in the word's source text.
function splitSubscriptAssignment(word) {
  const p0 = word.parts[0];
  const raw = word.value;
  const head = /^([A-Za-z_][A-Za-z0-9_]*)\[/.exec(p0.v);
  if (!head || typeof raw !== 'string' || !raw.startsWith(head[0])) return null;
  let depth = 0;
  let j = head[1].length;
  for (; j < raw.length; j++) {
    const c = raw[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  const tail = /^(\+?)=/.exec(raw.slice(j + 1));
  if (!tail) return null;
  const rest = raw.slice(j + 1 + tail[0].length);
  return {
    name: head[1],
    index: raw.slice(head[1].length + 1, j),
    append: tail[1] === '+',
    value: { parts: lexWordParts(rest) },
    array: null,
  };
}

function splitArithClauses(src) {
  const inner = src.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of inner) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  while (parts.length < 3) parts.push('');
  return parts;
}

class Parser {
  // `aliases` (optional) is { aliases, galiases, saliases } of Maps: plain
  // aliases expand in command position, global ones (-g) anywhere, and
  // suffix ones (-s) turn `notes.txt` into `vim notes.txt`.
  constructor(src, { aliases = null } = {}) {
    this.tokens = new Lexer(src).tokenize();
    this.i = 0;
    this.braceDepth = 0;
    this.alias = aliases;
  }

  // Replaces the word at the cursor with its alias, if it has one. Words that
  // came from an alias don't expand that alias again.
  expandAlias(commandPos) {
    if (!this.alias) return false;
    const t = this.peek();
    if (t.type !== 'WORD' || t.quoted || t.parts.length !== 1 || t.parts[0].t !== 'lit') return false;
    const name = t.parts[0].v;
    const seen = t.fromAlias || new Set();
    let text = null;
    let keepWord = false;
    const { aliases, galiases, saliases } = this.alias;
    if (commandPos && aliases && aliases.has(name) && !seen.has(name)) text = aliases.get(name);
    else if (galiases && galiases.has(name) && !seen.has(name)) text = galiases.get(name);
    else if (commandPos && saliases && saliases.size) {
      const ext = /\.([^./]+)$/.exec(name);
      if (ext && saliases.has(ext[1]) && !seen.has(`.${ext[1]}`)) { text = saliases.get(ext[1]); keepWord = true; seen.add(`.${ext[1]}`); }
    }
    if (text === null) return false;
    let toks;
    try {
      toks = new Lexer(text).tokenize().filter((x) => x.type !== 'EOF');
    } catch { return false; }
    const marks = new Set([...seen, name]);
    for (const x of toks) x.fromAlias = marks;
    // An alias ending in a space makes the next word eligible too.
    if (/\s$/.test(text)) this.aliasNextAt = this.i + toks.length + (keepWord ? 1 : 0);
    this.tokens.splice(this.i, 1, ...toks, ...(keepWord ? [Object.assign(t, { fromAlias: marks })] : []));
    return true;
  }

  peek(k = 0) { return this.tokens[Math.min(this.i + k, this.tokens.length - 1)]; }

  next() { return this.tokens[this.i++]; }

  at(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }

  atReserved(w) {
    const t = this.peek();
    return t.type === 'WORD' && t.reserved === w;
  }

  isRedirOp() {
    const t = this.peek();
    return t.type === 'OP' && REDIR_OPS.has(t.value);
  }

  expectReserved(w) {
    if (!this.atReserved(w)) this.unexpected(`'${w}'`);
    return this.next();
  }

  expectWord(what = 'a word') {
    if (!this.at('WORD')) this.unexpected(what);
    return this.next();
  }

  unexpected(expected) {
    const t = this.peek();
    if (t.type === 'EOF') {
      throw new IncompleteError(`unexpected end of input${expected ? `, expected ${expected}` : ''}`);
    }
    const near = t.type === 'NEWLINE' ? 'newline' : JSON.stringify(t.value);
    throw new ShellError(`syntax error near ${near}${expected ? `, expected ${expected}` : ''}`);
  }

  skipNewlines() { while (this.at('NEWLINE')) this.next(); }

  skipSeparators() { while (this.at('NEWLINE') || this.at('OP', ';')) this.next(); }

  // The next top-level command (with its ; or &), or null at the end — so a
  // script can run one command at a time and aliases defined on one line
  // apply to the next.
  parseNextItem() {
    this.skipSeparators();
    if (this.at('EOF')) return null;
    const node = this.parseAndOr();
    let sep = ';';
    if (this.at('OP', '&')) { this.next(); sep = '&'; } else if (this.at('OP', ';')) this.next();
    else if (!this.at('NEWLINE') && !this.at('EOF')) this.unexpected('end of input');
    return { type: 'List', items: [{ node, sep }] };
  }

  parseProgram() {
    const list = this.parseList(new Set());
    if (!this.at('EOF')) this.unexpected('end of input');
    return list;
  }

  atListEnd(enders) {
    const t = this.peek();
    if (t.type === 'EOF') return true;
    if (t.type === 'WORD' && t.reserved && enders.has(t.reserved)) return true;
    if (t.type === 'OP' && enders.has(t.value)) return true;
    return false;
  }

  parseList(enders) {
    const items = [];
    for (;;) {
      this.skipSeparators();
      if (this.atListEnd(enders)) break;
      const node = this.parseAndOr();
      let sep = ';';
      if (this.at('OP', '&')) { this.next(); sep = '&'; } else if (this.at('OP', ';')) {
        this.next();
      } else if (!this.at('NEWLINE')) {
        items.push({ node, sep });
        break;
      }
      items.push({ node, sep });
    }
    return { type: 'List', items };
  }

  parseAndOr() {
    let left = this.parsePipeline();
    while (this.at('OP', '&&') || this.at('OP', '||')) {
      const op = this.next().value;
      this.skipNewlines();
      left = { type: 'AndOr', op, left, right: this.parsePipeline() };
    }
    return left;
  }

  parsePipeline() {
    let negate = false;
    while (this.atReserved('!')) { this.next(); negate = !negate; }
    const commands = [this.parseCommand()];
    while (this.at('OP', '|') || this.at('OP', '|&')) {
      const both = this.next().value === '|&';
      commands[commands.length - 1].pipeStderr = both;
      this.skipNewlines();
      commands.push(this.parseCommand());
    }
    return { type: 'Pipeline', commands, negate };
  }

  withRedirects(node) {
    const reds = node.redirects || [];
    while (this.at('IONUM') || this.isRedirOp()) reds.push(this.parseRedirect());
    node.redirects = reds;
    return node;
  }

  parseRedirect() {
    let fd = null;
    if (this.at('IONUM')) fd = Number(this.next().value);
    const opTok = this.next();
    if (opTok.type !== 'OP' || !REDIR_OPS.has(opTok.value)) this.unexpected('a redirection');
    const target = this.expectWord('a redirection target');
    const r = { op: opTok.value, fd, target };
    if (opTok.value === '<<' || opTok.value === '<<-') {
      r.heredoc = opTok.heredoc || { body: '', expand: true };
    }
    return r;
  }

  parseCommand() {
    let guard = 0;
    while (this.expandAlias(true) && guard++ < 100) { /* expand again */ }
    const t = this.peek();

    if (t.type === 'ARITH') {
      this.next();
      return this.withRedirects({ type: 'ArithCmd', src: t.value });
    }

    if (t.type === 'OP' && t.value === '(') {
      this.next();
      const body = this.parseList(new Set([')']));
      if (!this.at('OP', ')')) this.unexpected("')'");
      this.next();
      return this.withRedirects({ type: 'Subshell', body });
    }

    if (t.type === 'WORD' && t.reserved) {
      switch (t.reserved) {
        case 'if': return this.withRedirects(this.parseIf());
        case 'while': case 'until': return this.withRedirects(this.parseWhile());
        case 'for': case 'select': return this.withRedirects(this.parseFor());
        case 'foreach': return this.withRedirects(this.parseForeach());
        case 'case': return this.withRedirects(this.parseCase());
        case 'repeat': return this.withRedirects(this.parseRepeat());
        case 'function': return this.parseFunctionKeyword();
        case '{': {
          const group = this.parseGroup();
          // { try } always { finally }
          if (this.at('WORD') && !this.peek().quoted && this.peek().value === 'always'
            && this.peek(1).type === 'WORD' && this.peek(1).reserved === '{') {
            this.next();
            const always = this.parseGroup();
            return this.withRedirects({ type: 'Always', body: group.body, always: always.body });
          }
          return this.withRedirects(group);
        }
        case '[[': return this.withRedirects(this.parseCondCommand());
        case 'time': this.next(); return { type: 'Time', command: this.parseCommand() };
        default: break;
      }
    }

    return this.parseSimple();
  }

  parseDoBlock() {
    this.skipSeparators();
    if (this.atReserved('{')) return this.parseGroup().body;
    this.expectReserved('do');
    const body = this.parseList(new Set(['done']));
    this.expectReserved('done');
    return body;
  }

  // zsh's short loops: `for x (a b) cmd` and `for ((…)) cmd` take a single
  // command in place of do … done.
  parseShortBody() {
    if (this.atReserved('do') || this.atReserved('{') || this.at('NEWLINE')) return this.parseDoBlock();
    const cmd = this.parsePipeline();
    return { type: 'List', items: [{ node: cmd, sep: ';' }] };
  }

  parseGroup() {
    this.expectReserved('{');
    this.braceDepth++;
    let body;
    try {
      body = this.parseList(new Set(['}']));
    } finally {
      this.braceDepth--;
    }
    this.expectReserved('}');
    return { type: 'Group', body };
  }

  parseIf() {
    this.expectReserved('if');
    const clauses = [];
    let cond = this.parseList(new Set(['then']));
    this.expectReserved('then');
    let body = this.parseList(new Set(['elif', 'else', 'fi']));
    clauses.push({ cond, body });

    while (this.atReserved('elif')) {
      this.next();
      cond = this.parseList(new Set(['then']));
      this.expectReserved('then');
      body = this.parseList(new Set(['elif', 'else', 'fi']));
      clauses.push({ cond, body });
    }

    let elseBody = null;
    if (this.atReserved('else')) {
      this.next();
      elseBody = this.parseList(new Set(['fi']));
    }
    this.expectReserved('fi');
    return { type: 'If', clauses, elseBody };
  }

  parseWhile() {
    const kind = this.peek().reserved;
    this.next();
    const cond = this.parseList(new Set(['do', '{']));
    const body = this.parseDoBlock();
    return { type: 'While', cond, body, until: kind === 'until' };
  }

  parseFor() {
    const kind = this.next().reserved;

    if (kind === 'for' && this.at('ARITH')) {
      const [init, cond, step] = splitArithClauses(this.next().value);
      if (this.at('OP', ';')) this.next();
      const body = this.parseShortBody();
      return { type: 'ForArith', init, cond, step, body };
    }

    const names = [wordText(this.expectWord('a loop variable'))];
    // zsh: for key value in ...; takes several at a time.
    while (this.at('WORD') && !this.peek().reserved && /^[A-Za-z_][A-Za-z0-9_]*$/.test(this.peek().value)) {
      names.push(wordText(this.next()));
    }
    const name = names[0];
    let items = null;
    let shortOk = false;

    if (this.atReserved('in')) {
      this.next();
      items = [];
      while (this.at('WORD') && this.peek().reserved !== 'do') items.push(this.next());
    } else if (this.at('OP', '(')) {
      this.next();
      items = [];
      this.skipNewlines();
      while (this.at('WORD')) { items.push(this.next()); this.skipNewlines(); }
      if (!this.at('OP', ')')) this.unexpected("')'");
      this.next();
      shortOk = true;
    }

    if (this.at('OP', ';')) this.next();
    const body = shortOk ? this.parseShortBody() : this.parseDoBlock();
    return { type: kind === 'select' ? 'Select' : 'For', name, names, items, body };
  }

  parseForeach() {
    this.expectReserved('foreach');
    const name = wordText(this.expectWord('a loop variable'));
    if (!this.at('OP', '(')) this.unexpected("'('");
    this.next();
    this.skipNewlines();
    const items = [];
    while (this.at('WORD')) { items.push(this.next()); this.skipNewlines(); }
    if (!this.at('OP', ')')) this.unexpected("')'");
    this.next();
    const body = this.parseList(new Set(['end']));
    this.expectReserved('end');
    return { type: 'For', name, items, body };
  }

  parseRepeat() {
    this.expectReserved('repeat');
    const count = this.expectWord('a repeat count');
    if (this.at('OP', ';')) this.next();
    // zsh's short form: repeat 3 echo hi
    if (!this.atReserved('do') && !this.atReserved('{') && !this.at('NEWLINE')) {
      const cmd = this.parsePipeline();
      return { type: 'Repeat', count, body: { type: 'List', items: [{ node: cmd, sep: ';' }] } };
    }
    const body = this.parseDoBlock();
    return { type: 'Repeat', count, body };
  }

  parseCase() {
    this.expectReserved('case');
    const word = this.expectWord('a word');
    this.skipNewlines();
    this.expectReserved('in');

    const cases = [];
    for (;;) {
      this.skipSeparators();
      if (this.atReserved('esac')) break;
      if (this.at('EOF')) this.unexpected("'esac'");
      if (this.at('OP', '(')) this.next();

      const patterns = [];
      for (;;) {
        patterns.push(this.expectWord('a pattern'));
        if (this.at('OP', '|')) { this.next(); continue; }
        break;
      }
      if (!this.at('OP', ')')) this.unexpected("')'");
      this.next();

      const body = this.parseList(new Set([';;', ';&', ';|', 'esac']));
      // ;& falls into the next body; ;| goes on testing the next patterns.
      let fall = false;
      let cont = false;
      if (this.at('OP', ';;')) this.next();
      else if (this.at('OP', ';&')) { this.next(); fall = true; } else if (this.at('OP', ';|')) { this.next(); cont = true; }
      cases.push({ patterns, body, fall, cont });
    }
    this.expectReserved('esac');
    return { type: 'Case', word, cases };
  }

  parseFunctionKeyword() {
    this.expectReserved('function');
    const name = wordText(this.expectWord('a function name'));
    if (this.at('OP', '(')) {
      this.next();
      if (!this.at('OP', ')')) this.unexpected("')'");
      this.next();
    }
    this.skipNewlines();
    return { type: 'FunctionDef', name, body: this.parseCommand() };
  }

  parseCondCommand() {
    this.expectReserved('[[');
    const expr = this.parseCondOr();
    if (!this.atReserved(']]')) this.unexpected("']]'");
    this.next();
    return { type: 'Cond', expr };
  }

  parseCondOr() {
    let left = this.parseCondAnd();
    while (this.at('OP', '||')) {
      this.next();
      left = { type: 'CondOr', left, right: this.parseCondAnd() };
    }
    return left;
  }

  parseCondAnd() {
    let left = this.parseCondTerm();
    while (this.at('OP', '&&')) {
      this.next();
      left = { type: 'CondAnd', left, right: this.parseCondTerm() };
    }
    return left;
  }

  parseCondTerm() {
    if (this.atReserved('!')) {
      this.next();
      return { type: 'CondNot', expr: this.parseCondTerm() };
    }
    if (this.at('OP', '(')) {
      this.next();
      const e = this.parseCondOr();
      if (!this.at('OP', ')')) this.unexpected("')'");
      this.next();
      return e;
    }

    const t = this.peek();
    if (t.type === 'WORD' && !t.quoted && COND_UNARY.has(t.value)) {
      this.next();
      return { type: 'CondUnary', op: t.value, word: this.expectWord('an operand') };
    }

    const left = this.expectWord('a condition');
    const nt = this.peek();
    if (nt.type === 'WORD' && !nt.quoted && COND_BINARY.has(nt.value)) {
      this.next();
      return { type: 'CondBinary', op: nt.value, left, right: this.expectWord('an operand') };
    }
    if (nt.type === 'OP' && (nt.value === '<' || nt.value === '>')) {
      this.next();
      return { type: 'CondBinary', op: nt.value, left, right: this.expectWord('an operand') };
    }
    return { type: 'CondWord', word: left };
  }

  parseSimple() {
    const assigns = [];
    const words = [];
    const redirects = [];

    for (;;) {
      if (this.at('IONUM') || this.isRedirOp()) { redirects.push(this.parseRedirect()); continue; }
      if (!this.at('WORD')) break;

      // Aliases: in command position (also after assignments), after an
      // alias ending in a space, and global aliases anywhere.
      if (this.alias) {
        const cmdPos = words.length === 0 || this.i === this.aliasNextAt;
        if (this.expandAlias(cmdPos)) {
          if (words.length === 0 && this.peek().type === 'WORD' && this.peek().reserved && !assigns.length) {
            return this.parseCommand();
          }
          continue;
        }
      }

      const t = this.peek();
      const atStart = words.length === 0 && assigns.length === 0;
      if (words.length === 0 && t.reserved && CLOSERS.has(t.reserved)) break;
      // zsh allows `{ cmd }` with no separator before the closing brace.
      if (t.reserved === '}' && this.braceDepth > 0) break;

      if (atStart && !splitAssignment(t)
        && this.peek(1).type === 'OP' && this.peek(1).value === '('
        && this.peek(2).type === 'OP' && this.peek(2).value === ')') {
        const name = wordText(t);
        this.i += 3;
        this.skipNewlines();
        return { type: 'FunctionDef', name, body: this.parseCommand() };
      }

      if (words.length === 0) {
        const a = splitAssignment(t);
        if (a) {
          this.next();
          if (a.value.parts.length === 0 && this.at('OP', '(')) {
            this.next();
            this.skipNewlines();
            const elems = [];
            while (this.at('WORD')) { elems.push(this.next()); this.skipNewlines(); }
            if (!this.at('OP', ')')) this.unexpected("')'");
            this.next();
            a.array = elems;
          }
          assigns.push(a);
          continue;
        }
      }

      // typeset/local/declare/export/readonly name=(a b c) — an array
      // assignment as an argument.
      if (words.length && DECLARERS.has(wordText(words[0])) && !words[0].quoted) {
        const a = splitAssignment(t);
        if (a && a.value.parts.length === 0 && this.peek(1).type === 'OP' && this.peek(1).value === '(') {
          this.next();
          this.next();
          this.skipNewlines();
          const elems = [];
          while (this.at('WORD')) { elems.push(this.next()); this.skipNewlines(); }
          if (!this.at('OP', ')')) this.unexpected("')'");
          this.next();
          words.push({ type: 'WORD', value: t.value, parts: t.parts, quoted: false, declArray: { name: a.name, append: a.append, elems } });
          continue;
        }
      }

      words.push(this.next());
    }

    if (!words.length && !assigns.length && !redirects.length) this.unexpected('a command');
    return { type: 'Simple', assigns, words, redirects };
  }
}

function parse(src) {
  return new Parser(src).parseProgram();
}

module.exports = { Parser, parse, wordText, splitAssignment, DECLARERS };
