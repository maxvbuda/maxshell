'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const { Lexer, ShellError, IncompleteError, lexHeredocParts } = require('./lexer');
const { Parser } = require('./parser');
const {
  expandWord, expandWords, expandToString, expandToPattern, matchPattern,
} = require('./expand');
const { evalArith } = require('./arith');
const { BUILTINS, testUnary, testBinary } = require('./builtins');
const {
  BreakSignal, ContinueSignal, ReturnSignal, ExitSignal,
} = require('./signals');

const TERM_IN = { kind: 'term', which: 'in' };
const TERM_OUT = { kind: 'term', which: 'out' };
const TERM_ERR = { kind: 'term', which: 'err' };

class Shell {
  constructor(opts = {}) {
    this.output = opts.output || null;
    this.errorOutput = opts.error || null;
    this.interactive = !!opts.interactive;

    this.env = { ...process.env };
    this.cwd = opts.cwd || process.cwd();
    this.vars = new Map();
    this.scopes = [this.vars];
    this.funcs = new Map();
    this.aliases = new Map();
    this.options = new Set();
    this.positional = opts.positional || [];
    this.scriptName = opts.name || 'maxshell';
    this.status = 0;
    this.exited = false;
    this.history = [];
    this.dirStack = [];
    this.dirBack = [];
    this.dirForward = [];
    this.lastNotFound = null;
    this.jobs = [];
    this.lastBgPid = null;
    this.startTime = Date.now();
    this.condDepth = 0;
    this.curIo = null;

    this._outBuf = '';
    this._errBuf = '';

    this.env.PWD = this.cwd;
    this.env.SHELL = this.env.SHELL || 'maxshell';
  }

  // --- variables ------------------------------------------------------------

  findEntry(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      if (scope.has(name)) return scope.get(name);
    }
    return null;
  }

  getVar(name) {
    switch (name) {
      case '?': return String(this.status);
      case '#': return String(this.positional.length);
      case '$': return String(process.pid);
      case '!': return this.lastBgPid === null ? '' : String(this.lastBgPid);
      case '0': return this.scriptName;
      case '-': return [...this.options].join('');
      case '@': case '*': return this.positional.join(' ');
      case 'RANDOM': return String(Math.floor(Math.random() * 32768));
      case 'SECONDS': return String(Math.floor((Date.now() - this.startTime) / 1000));
      default: break;
    }
    if (/^[1-9][0-9]*$/.test(name)) return this.positional[Number(name) - 1];

    const entry = this.findEntry(name);
    if (entry) return Array.isArray(entry.value) ? entry.value.join(' ') : entry.value;
    return this.env[name];
  }

  getArray(name) {
    const entry = this.findEntry(name);
    return entry && Array.isArray(entry.value) ? entry.value : null;
  }

  setVar(name, value) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      if (scope.has(name)) {
        const entry = scope.get(name);
        entry.value = value;
        if (entry.exported) this.env[name] = Array.isArray(value) ? value.join(' ') : value;
        return;
      }
    }
    const exported = Object.prototype.hasOwnProperty.call(this.env, name);
    this.vars.set(name, { value, exported });
    if (exported) this.env[name] = Array.isArray(value) ? value.join(' ') : value;
  }

  setArray(name, values) {
    this.setVar(name, values);
  }

  unsetVar(name) {
    for (const scope of this.scopes) scope.delete(name);
    delete this.env[name];
  }

  exportVar(name) {
    const entry = this.findEntry(name);
    if (entry) {
      entry.exported = true;
      this.env[name] = Array.isArray(entry.value) ? entry.value.join(' ') : entry.value;
      return;
    }
    const existing = this.env[name] ?? '';
    this.vars.set(name, { value: existing, exported: true });
    this.env[name] = existing;
  }

  resolve(p) {
    return path.isAbsolute(p) ? p : path.resolve(this.cwd, p);
  }

  // Changes directory. Every move is remembered for `back` / `forward`;
  // those pass { record: false } so walking the history doesn't rewrite it.
  setCwd(dir, { record = true } = {}) {
    const home = this.getVar('HOME') || os.homedir();
    const target = this.resolve(dir.replace(/^~(?=$|\/)/, home));
    const st = fs.statSync(target);
    if (!st.isDirectory()) {
      const e = new Error('not a directory');
      e.code = 'ENOTDIR';
      throw e;
    }
    const real = fs.realpathSync(target);
    if (record && real !== this.cwd) {
      this.dirBack.push(this.cwd);
      if (this.dirBack.length > 100) this.dirBack.shift();
      this.dirForward = [];
    }
    this.env.OLDPWD = this.cwd;
    this.setVar('OLDPWD', this.cwd);
    this.cwd = real;
    this.env.PWD = real;
    this.setVar('PWD', real);
  }

  // --- io -------------------------------------------------------------------

  writeStdout(text) {
    if (!this.output) { process.stdout.write(text); return; }
    this._outBuf += text;
    let nl;
    while ((nl = this._outBuf.indexOf('\n')) !== -1) {
      this.output(this._outBuf.slice(0, nl));
      this._outBuf = this._outBuf.slice(nl + 1);
    }
  }

  writeStderr(text) {
    if (!this.errorOutput) { process.stderr.write(text); return; }
    this._errBuf += text;
    let nl;
    while ((nl = this._errBuf.indexOf('\n')) !== -1) {
      this.errorOutput(this._errBuf.slice(0, nl));
      this._errBuf = this._errBuf.slice(nl + 1);
    }
  }

  flush() {
    if (this.output && this._outBuf) { this.output(this._outBuf); this._outBuf = ''; }
    if (this.errorOutput && this._errBuf) { this.errorOutput(this._errBuf); this._errBuf = ''; }
  }

  writeTo(desc, text) {
    if (!text) return;
    switch (desc.kind) {
      case 'capture': desc.chunks.push(text); return;
      case 'file': fs.writeSync(desc.fd, text); return;
      case 'null': return;
      default:
        if (desc.which === 'err') this.writeStderr(text);
        else this.writeStdout(text);
    }
  }

  readAll(desc) {
    if (!desc) return '';
    if (desc.kind === 'string') {
      const rest = desc.data.slice(desc.pos);
      desc.pos = desc.data.length;
      return rest;
    }
    if (desc.kind === 'fd') {
      const chunks = [];
      const buf = Buffer.alloc(65536);
      for (;;) {
        let n = 0;
        try { n = fs.readSync(desc.fd, buf, 0, buf.length, null); } catch { n = 0; }
        if (!n) break;
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    return '';
  }

  readLine(desc) {
    if (!desc) return null;
    if (desc.kind === 'string') {
      if (desc.pos >= desc.data.length) return null;
      const nl = desc.data.indexOf('\n', desc.pos);
      const line = nl === -1 ? desc.data.slice(desc.pos) : desc.data.slice(desc.pos, nl);
      desc.pos = nl === -1 ? desc.data.length : nl + 1;
      return line;
    }
    if (desc.kind === 'fd' || (desc.kind === 'term' && !this.output)) {
      const fd = desc.kind === 'fd' ? desc.fd : 0;
      const buf = Buffer.alloc(1);
      let line = '';
      for (;;) {
        let n = 0;
        try { n = fs.readSync(fd, buf, 0, 1, null); } catch { n = 0; }
        if (!n) return line === '' ? null : line;
        const c = buf.toString('utf8');
        if (c === '\n') return line;
        line += c;
      }
    }
    return null;
  }

  // --- running --------------------------------------------------------------

  defaultIo() {
    return { stdin: TERM_IN, stdout: TERM_OUT, stderr: TERM_ERR };
  }

  run(src) {
    try {
      return this.runSource(src, this.defaultIo());
    } catch (e) {
      if (e instanceof ExitSignal) { this.exited = true; return this.setStatus(e.status); }
      throw e;
    } finally {
      this.flush();
    }
  }

  runSource(src, io) {
    return this.exec(new Parser(src).parseProgram(), io || this.defaultIo());
  }

  captureOutput(src) {
    const sink = { kind: 'capture', chunks: [] };
    const io = {
      stdin: this.curIo ? this.curIo.stdin : TERM_IN,
      stdout: sink,
      stderr: this.curIo ? this.curIo.stderr : TERM_ERR,
    };
    try {
      this.exec(new Parser(src).parseProgram(), io);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
    return sink.chunks.join('');
  }

  setStatus(n) {
    this.status = n;
    return n;
  }

  exec(node, io) {
    switch (node.type) {
      case 'List': return this.execList(node, io);
      case 'AndOr': return this.execAndOr(node, io);
      case 'Pipeline': return this.execPipeline(node, io);
      case 'FunctionDef':
        this.funcs.set(node.name, node);
        return this.setStatus(0);
      default: return this.execRedirected(node, io);
    }
  }

  execList(node, io) {
    let status = this.status;
    for (const item of node.items) {
      status = item.sep === '&' ? this.execBackground(item.node, io) : this.exec(item.node, io);
      if (this.options.has('e') && status !== 0 && this.condDepth === 0) throw new ExitSignal(status);
    }
    return status;
  }

  execAndOr(node, io) {
    this.condDepth++;
    let left;
    try {
      left = this.exec(node.left, io);
    } finally {
      this.condDepth--;
    }
    const proceed = node.op === '&&' ? left === 0 : left !== 0;
    return proceed ? this.exec(node.right, io) : this.setStatus(left);
  }

  execPipeline(node, io) {
    const cmds = node.commands;
    let status;

    if (cmds.length === 1) {
      status = this.exec(cmds[0], io);
    } else {
      const statuses = [];
      let input = io.stdin;
      for (let i = 0; i < cmds.length; i++) {
        const last = i === cmds.length - 1;
        const sink = last ? io.stdout : { kind: 'capture', chunks: [] };
        status = this.exec(cmds[i], {
          stdin: input,
          stdout: sink,
          stderr: cmds[i].pipeStderr ? sink : io.stderr,
        });
        statuses.push(status);
        if (!last) input = { kind: 'string', data: sink.chunks.join(''), pos: 0 };
      }
      if (this.options.has('pipefail')) status = statuses.find((s) => s !== 0) ?? 0;
    }

    if (node.negate) status = status === 0 ? 1 : 0;
    return this.setStatus(status);
  }

  execBackground(node, io) {
    const single = node.type === 'Pipeline' && !node.negate && node.commands.length === 1
      ? node.commands[0]
      : null;

    if (single && single.type === 'Simple' && !single.redirects.length) {
      const argv = this.expandAliases(expandWords(this, single.words));
      if (argv.length && !this.funcs.has(argv[0]) && !BUILTINS[argv[0]]) {
        try {
          const child = spawn(argv[0], argv.slice(1), {
            cwd: this.cwd, env: this.env, stdio: 'inherit', detached: true,
          });
          child.unref();
          this.lastBgPid = child.pid;
          this.jobs.push({ pid: child.pid, cmd: argv.join(' ') });
          if (this.interactive) this.writeStderr(`[${this.jobs.length}] ${child.pid}\n`);
          return this.setStatus(0);
        } catch { /* fall back to running it synchronously */ }
      }
    }
    return this.exec(node, io);
  }

  execRedirected(node, io) {
    const { io: rio, opened } = this.applyRedirects(node.redirects, io);
    const saved = this.curIo;
    this.curIo = rio;
    try {
      return this.execNode(node, rio);
    } finally {
      this.curIo = saved;
      for (const fd of opened) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  execNode(node, io) {
    switch (node.type) {
      case 'Simple': return this.execSimple(node, io);
      case 'Group': return this.exec(node.body, io);
      case 'Subshell': return this.execSubshell(node, io);
      case 'If': return this.execIf(node, io);
      case 'While': return this.execWhile(node, io);
      case 'For': return this.execFor(node, io);
      case 'ForArith': return this.execForArith(node, io);
      case 'Repeat': return this.execRepeat(node, io);
      case 'Case': return this.execCase(node, io);
      case 'Cond': return this.setStatus(this.evalCond(node.expr) ? 0 : 1);
      case 'ArithCmd': return this.setStatus(evalArith(node.src, this) ? 0 : 1);
      case 'Time': return this.execTime(node, io);
      case 'Pipeline': return this.execPipeline(node, io);
      case 'List': return this.execList(node, io);
      case 'AndOr': return this.execAndOr(node, io);
      case 'FunctionDef':
        this.funcs.set(node.name, node);
        return this.setStatus(0);
      default:
        throw new ShellError(`cannot execute ${node.type}`);
    }
  }

  snapshot() {
    return {
      vars: new Map([...this.vars].map(([k, v]) => [k, { ...v }])),
      env: { ...this.env },
      cwd: this.cwd,
      funcs: new Map(this.funcs),
      aliases: new Map(this.aliases),
      positional: this.positional.slice(),
      options: new Set(this.options),
    };
  }

  restore(s) {
    this.vars = s.vars;
    this.scopes = [this.vars];
    this.env = s.env;
    this.cwd = s.cwd;
    this.funcs = s.funcs;
    this.aliases = s.aliases;
    this.positional = s.positional;
    this.options = s.options;
  }

  execSubshell(node, io) {
    const snap = this.snapshot();
    try {
      return this.exec(node.body, io);
    } catch (e) {
      if (e instanceof ExitSignal) return this.setStatus(e.status);
      throw e;
    } finally {
      this.restore(snap);
    }
  }

  execCondition(node, io) {
    this.condDepth++;
    try {
      return this.exec(node, io);
    } finally {
      this.condDepth--;
    }
  }

  execIf(node, io) {
    for (const clause of node.clauses) {
      if (this.execCondition(clause.cond, io) === 0) return this.exec(clause.body, io);
    }
    if (node.elseBody) return this.exec(node.elseBody, io);
    return this.setStatus(0);
  }

  // Runs one loop iteration, returning 'ok', 'break', or 'continue'.
  runIteration(body, io, state) {
    try {
      state.status = this.exec(body, io);
      return 'ok';
    } catch (e) {
      if (e instanceof BreakSignal) {
        if (--e.count > 0) throw e;
        return 'break';
      }
      if (e instanceof ContinueSignal) {
        if (--e.count > 0) throw e;
        return 'continue';
      }
      throw e;
    }
  }

  execWhile(node, io) {
    const state = { status: 0 };
    for (;;) {
      const ok = this.execCondition(node.cond, io) === 0;
      if (node.until ? ok : !ok) break;
      if (this.runIteration(node.body, io, state) === 'break') break;
    }
    return this.setStatus(state.status);
  }

  execFor(node, io) {
    const items = node.items === null ? this.positional.slice() : expandWords(this, node.items);
    const state = { status: 0 };
    for (const item of items) {
      this.setVar(node.name, item);
      if (this.runIteration(node.body, io, state) === 'break') break;
    }
    return this.setStatus(state.status);
  }

  execForArith(node, io) {
    const state = { status: 0 };
    if (node.init.trim()) evalArith(node.init, this);
    for (;;) {
      if (node.cond.trim() && !evalArith(node.cond, this)) break;
      if (this.runIteration(node.body, io, state) === 'break') break;
      if (node.step.trim()) evalArith(node.step, this);
    }
    return this.setStatus(state.status);
  }

  execRepeat(node, io) {
    const n = Math.trunc(Number(expandToString(this, node.count)) || 0);
    const state = { status: 0 };
    for (let i = 0; i < n; i++) {
      if (this.runIteration(node.body, io, state) === 'break') break;
    }
    return this.setStatus(state.status);
  }

  execCase(node, io) {
    const subject = expandToString(this, node.word);
    let matched = false;
    let status = 0;
    for (const clause of node.cases) {
      if (!matched) {
        matched = clause.patterns.some((p) => matchPattern(expandToPattern(this, p), subject));
        if (!matched) continue;
      }
      status = this.exec(clause.body, io);
      if (!clause.fall) break;
    }
    return this.setStatus(matched ? status : 0);
  }

  execTime(node, io) {
    const start = process.hrtime.bigint();
    try {
      return this.exec(node.command, io);
    } finally {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.writeTo(io.stderr, `${seconds.toFixed(3)}s total\n`);
    }
  }

  evalCond(node) {
    switch (node.type) {
      case 'CondNot': return !this.evalCond(node.expr);
      case 'CondAnd': return this.evalCond(node.left) && this.evalCond(node.right);
      case 'CondOr': return this.evalCond(node.left) || this.evalCond(node.right);
      case 'CondWord': return expandToString(this, node.word) !== '';
      case 'CondUnary': return testUnary(node.op, expandToString(this, node.word), this);
      case 'CondBinary': {
        const left = expandToString(this, node.left);
        if (node.op === '=~') return new RegExp(expandToString(this, node.right)).test(left);
        if (node.op === '=' || node.op === '==' || node.op === '!=') {
          const hit = matchPattern(expandToPattern(this, node.right), left);
          return node.op === '!=' ? !hit : hit;
        }
        return testBinary(node.op, left, expandToString(this, node.right), this);
      }
      default: return false;
    }
  }

  // --- simple commands ------------------------------------------------------

  expandAliases(argv) {
    let result = argv;
    const seen = new Set();
    while (result.length && this.aliases.has(result[0]) && !seen.has(result[0])) {
      const name = result[0];
      seen.add(name);
      const words = new Lexer(this.aliases.get(name)).tokenize().filter((t) => t.type === 'WORD');
      const head = [];
      for (const w of words) head.push(...expandWord(this, w));
      if (!head.length) break;
      result = head.concat(result.slice(1));
    }
    return result;
  }

  doAssign(a) {
    if (a.array) {
      const values = expandWords(this, a.array);
      const current = a.append ? (this.getArray(a.name) || []) : [];
      this.setArray(a.name, current.concat(values));
      return;
    }
    const value = expandToString(this, a.value);
    if (a.index !== null && a.index !== undefined) {
      const arr = (this.getArray(a.name) || []).slice();
      const n = Math.trunc(evalArith(a.index, this));
      arr[n < 0 ? arr.length + n : n - 1] = value;
      for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = '';
      this.setArray(a.name, arr);
      return;
    }
    this.setVar(a.name, a.append ? (this.getVar(a.name) ?? '') + value : value);
  }

  execSimple(node, io) {
    let argv = [];
    for (const w of node.words) argv.push(...expandWord(this, w));
    argv = this.expandAliases(argv);

    if (argv.length === 0) {
      for (const a of node.assigns) this.doAssign(a);
      return this.setStatus(0);
    }

    const overrides = {};
    for (const a of node.assigns) {
      overrides[a.name] = a.array
        ? expandWords(this, a.array).join(' ')
        : expandToString(this, a.value);
    }

    if (this.options.has('x')) this.writeStderr(`+ ${argv.join(' ')}\n`);

    const name = argv[0];
    const isLocal = this.funcs.has(name) || !!BUILTINS[name];
    const names = Object.keys(overrides);

    if (isLocal && names.length) {
      const saved = names.map((k) => [k, this.findEntry(k), this.getVar(k)]);
      for (const k of names) this.setVar(k, overrides[k]);
      try {
        return this.setStatus(this.dispatch(name, argv, io));
      } finally {
        for (const [k, entry, value] of saved) {
          if (entry === null && value === undefined) this.unsetVar(k);
          else this.setVar(k, value);
        }
      }
    }

    if (isLocal) return this.setStatus(this.dispatch(name, argv, io));
    return this.setStatus(this.runExternal(argv, io, { ...this.env, ...overrides }));
  }

  dispatch(name, argv, io) {
    if (this.funcs.has(name)) return this.runFunction(name, argv, io);
    const saved = this.curIo;
    this.curIo = io;
    try {
      return BUILTINS[name](argv.slice(1), io, this) ?? 0;
    } finally {
      this.curIo = saved;
    }
  }

  runFunction(name, argv, io) {
    const fn = this.funcs.get(name);
    const savedPositional = this.positional;
    this.positional = argv.slice(1);
    this.scopes.push(new Map());
    try {
      return this.exec(fn.body, io);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.status;
      throw e;
    } finally {
      this.scopes.pop();
      this.positional = savedPositional;
    }
  }

  applyRedirects(redirects, io) {
    if (!redirects || !redirects.length) return { io, opened: [] };

    const out = { stdin: io.stdin, stdout: io.stdout, stderr: io.stderr };
    const opened = [];
    const setFd = (n, desc) => {
      if (n === 0) out.stdin = desc;
      else if (n === 2) out.stderr = desc;
      else out.stdout = desc;
    };
    const getFd = (n) => (n === 0 ? out.stdin : n === 2 ? out.stderr : out.stdout);

    for (const r of redirects) {
      const { op } = r;

      if (op === '<<' || op === '<<-') {
        let body = r.heredoc ? r.heredoc.body : '';
        if (r.heredoc && r.heredoc.expand) body = expandToString(this, lexHeredocParts(body));
        out.stdin = { kind: 'string', data: body, pos: 0 };
        continue;
      }
      if (op === '<<<') {
        out.stdin = { kind: 'string', data: `${expandToString(this, r.target)}\n`, pos: 0 };
        continue;
      }
      if (op === '>&' || op === '<&') {
        const text = expandToString(this, r.target);
        const from = r.fd ?? (op === '>&' ? 1 : 0);
        if (text === '-') { setFd(from, { kind: 'null' }); continue; }
        if (/^\d+$/.test(text)) { setFd(from, getFd(Number(text))); continue; }
        const fd = fs.openSync(this.resolve(text), 'w');
        opened.push(fd);
        setFd(from, { kind: 'file', fd });
        continue;
      }

      const target = expandToString(this, r.target);
      const both = op === '&>' || op === '&>>';

      if (target === '/dev/null') {
        if (op === '<') out.stdin = { kind: 'string', data: '', pos: 0 };
        else if (both) { out.stdout = { kind: 'null' }; out.stderr = { kind: 'null' }; }
        else setFd(r.fd ?? 1, { kind: 'null' });
        continue;
      }

      const resolved = this.resolve(target);
      if (op === '<') {
        const fd = fs.openSync(resolved, 'r');
        opened.push(fd);
        out.stdin = { kind: 'fd', fd };
        continue;
      }

      const fd = fs.openSync(resolved, op === '>>' || op === '&>>' ? 'a' : 'w');
      opened.push(fd);
      const desc = { kind: 'file', fd };
      if (both) { out.stdout = desc; out.stderr = desc; } else setFd(r.fd ?? 1, desc);
    }

    return { io: out, opened };
  }

  runExternal(argv, io, env) {
    const stdio = [null, null, null];
    let input;

    const captureOut = io.stdout.kind === 'capture' || (io.stdout.kind === 'term' && !!this.output);
    const captureErr = io.stderr.kind === 'capture' || (io.stderr.kind === 'term' && !!this.errorOutput);

    if (io.stdin.kind === 'string') {
      stdio[0] = 'pipe';
      input = io.stdin.data.slice(io.stdin.pos);
      io.stdin.pos = io.stdin.data.length;
    } else if (io.stdin.kind === 'fd') stdio[0] = io.stdin.fd;
    else if (io.stdin.kind === 'null') stdio[0] = 'ignore';
    else stdio[0] = 'inherit';

    if (io.stdout.kind === 'file') stdio[1] = io.stdout.fd;
    else if (io.stdout.kind === 'null') stdio[1] = 'ignore';
    else stdio[1] = captureOut ? 'pipe' : 'inherit';

    if (io.stderr.kind === 'file') stdio[2] = io.stderr.fd;
    else if (io.stderr.kind === 'null') stdio[2] = 'ignore';
    else stdio[2] = captureErr ? 'pipe' : 'inherit';

    const res = spawnSync(argv[0], argv.slice(1), {
      cwd: this.cwd,
      env,
      stdio,
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    if (res.error) {
      if (res.error.code === 'ENOENT') {
        let guess = null;
        try { guess = require('./suggest').suggestCommand(argv[0], this); } catch { /* best effort */ }
        this.lastNotFound = { name: argv[0], guess };
        const hint = guess ? ` — did you mean ${guess}?` : '';
        this.writeTo(io.stderr, `maxshell: command not found: ${argv[0]}${hint}\n`);
        return 127;
      }
      if (res.error.code === 'EACCES') {
        this.writeTo(io.stderr, `maxshell: permission denied: ${argv[0]}\n`);
        return 126;
      }
      this.writeTo(io.stderr, `maxshell: ${argv[0]}: ${res.error.message}\n`);
      return 1;
    }

    if (res.stdout) this.writeTo(io.stdout, res.stdout);
    if (res.stderr) this.writeTo(io.stderr, res.stderr);
    // Killed by a signal: 128 + its number, as shells report (Ctrl-C → 130).
    if (res.signal) return 128 + (os.constants.signals[res.signal] || 0);
    return res.status ?? 0;
  }
}

module.exports = {
  Shell,
  ShellError,
  IncompleteError,
  ExitSignal,
  TERM_IN,
  TERM_OUT,
  TERM_ERR,
};
