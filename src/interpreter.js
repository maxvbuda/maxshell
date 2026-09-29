'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const { Lexer, ShellError, IncompleteError, lexHeredocParts } = require('./lexer');
const { Parser, DECLARERS, splitAssignment } = require('./parser');
const {
  expandWord, expandWords, expandToString, expandToPattern, matchPattern,
} = require('./expand');
const { evalArith, evalValue, formatValue } = require('./arith');
const {
  BUILTINS, testUnary, testBinary, findInPath,
} = require('./builtins');
const {
  BreakSignal, ContinueSignal, ReturnSignal, ExitSignal, InterruptSignal,
} = require('./signals');
const jobs = require('./jobs');

// A variable's value as one string: arrays join with spaces, and an
// associative array gives its values.
function scalarOf(value) {
  if (Array.isArray(value)) return value.join(' ');
  if (value instanceof Map) return [...value.values()].join(' ');
  return value;
}

// Where we start: $PWD if it names the directory we're in (keeping the
// path you used, symlinks and all), otherwise the physical path.
function logicalStart() {
  const real = process.cwd();
  const pwd = process.env.PWD;
  try {
    if (pwd && path.isAbsolute(pwd) && fs.realpathSync(pwd) === fs.realpathSync(real)) return pwd;
  } catch { /* fall through */ }
  return real;
}

// Reads from a descriptor, waiting when it has nothing yet: a terminal's
// stdin is non-blocking under Node, so a plain read fails with EAGAIN
// instead of waiting for the user to type. Returns 0 at end of input.
function readRetrying(fd, buf, len) {
  for (;;) {
    try {
      return fs.readSync(fd, buf, 0, len, null);
    } catch (e) {
      if (e.code !== 'EAGAIN') return 0;
      jobs.sleep(10);
    }
  }
}

// The system shell that runs streaming pipelines.
const SH = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

const TERM_IN = { kind: 'term', which: 'in' };
const TERM_OUT = { kind: 'term', which: 'out' };
const TERM_ERR = { kind: 'term', which: 'err' };

class Shell {
  constructor(opts = {}) {
    this.output = opts.output || null;
    this.errorOutput = opts.error || null;
    this.interactive = !!opts.interactive;

    this.env = { ...process.env };
    this.cwd = opts.cwd || logicalStart();
    this.vars = new Map();
    this.scopes = [this.vars];
    this.funcs = new Map();
    this.aliases = new Map();
    this.galiases = new Map();
    this.saliases = new Map();
    this.abbrs = new Map();
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
    this.currentJob = null;
    this.interrupted = false;
    this.lastBgPid = null;
    this.startTime = Date.now();
    this.condDepth = 0;
    this.curIo = null;
    this.traps = new Map();
    this.funcDepth = 0;
    this.loopDepth = 0;
    this.substStatus = null;
    if (this.interactive) this.options.add('autocd');

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
      case '-': return [...this.options].filter((o) => o.length === 1).join('');
      case '@': case '*': return this.positional.join(' ');
      case 'RANDOM': return String(Math.floor(Math.random() * 32768));
      case 'SECONDS': return String(Math.floor((Date.now() - this.startTime) / 1000));
      case 'EPOCHSECONDS': return String(Math.floor(Date.now() / 1000));
      case 'EPOCHREALTIME': return (Date.now() / 1000).toFixed(6);
      case 'PPID': return String(process.ppid);
      case 'UID': return String(process.getuid ? process.getuid() : 0);
      case 'SHLVL': return this.env.SHLVL;
      default: break;
    }
    if (/^[1-9][0-9]*$/.test(name)) return this.positional[Number(name) - 1];

    const entry = this.findEntry(name);
    if (entry) return scalarOf(entry.value);
    return this.env[name];
  }

  getArray(name) {
    const entry = this.findEntry(name);
    if (!entry) return null;
    if (Array.isArray(entry.value)) return entry.value;
    if (entry.value instanceof Map) return [...entry.value.values()];
    return null;
  }

  // Assigns, honouring attributes: readonly refuses, integer evaluates,
  // lower/upper case convert. Arrays and Maps are stored as they are.
  setVar(name, value) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      if (scope.has(name)) {
        const entry = scope.get(name);
        entry.value = this.coerce(name, entry, value);
        if (entry.exported) this.env[name] = scalarOf(entry.value);
        return;
      }
    }
    const exported = Object.prototype.hasOwnProperty.call(this.env, name) || this.options.has('allexport');
    this.vars.set(name, { value, exported });
    if (exported) this.env[name] = scalarOf(value);
  }

  coerce(name, entry, value) {
    if (entry.readonly) throw new ShellError(`read-only variable: ${name}`);
    if (typeof value !== 'string') return value;
    if (entry.integer) {
      const n = evalValue(value || '0', this);
      return (typeof n === 'bigint' ? n : BigInt.asIntN(64, BigInt(Math.trunc(n)))).toString();
    }
    if (entry.float) return formatValue(Number(evalValue(value || '0', this)));
    if (entry.lower) return value.toLowerCase();
    if (entry.upper) return value.toUpperCase();
    return value;
  }

  setArray(name, values) {
    this.setVar(name, values);
  }

  unsetVar(name) {
    const entry = this.findEntry(name);
    if (entry && entry.readonly) throw new ShellError(`read-only variable: ${name}`);
    for (const scope of this.scopes) scope.delete(name);
    delete this.env[name];
  }

  exportVar(name) {
    const entry = this.findEntry(name);
    if (entry) {
      entry.exported = true;
      this.env[name] = scalarOf(entry.value);
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
  // Directories are tracked logically, as in zsh: `cd /tmp` shows /tmp
  // even though it's a symlink, and `cd ..` goes back the way you came.
  setCwd(dir, { record = true, physical = false } = {}) {
    const home = this.getVar('HOME') || os.homedir();
    const expanded = dir.replace(/^~(?=$|\/)/, home);
    let target = path.isAbsolute(expanded) ? path.normalize(expanded) : path.normalize(path.join(this.cwd, expanded));
    if (target.length > 1) target = target.replace(/\/+$/, '');
    const st = fs.statSync(target);
    if (!st.isDirectory()) {
      const e = new Error('not a directory');
      e.code = 'ENOTDIR';
      throw e;
    }
    fs.accessSync(target, fs.constants.X_OK);
    if (physical || this.options.has('chaselinks')) target = fs.realpathSync(target);
    if (record && target !== this.cwd) {
      this.dirBack.push(this.cwd);
      if (this.dirBack.length > 100) this.dirBack.shift();
      this.dirForward = [];
    }
    this.env.OLDPWD = this.cwd;
    this.setVar('OLDPWD', this.cwd);
    this.cwd = target;
    this.env.PWD = target;
    this.setVar('PWD', target);
    if (this.funcs.has('chpwd')) {
      try { this.dispatch('chpwd', ['chpwd'], this.curIo || this.defaultIo()); } catch (e) { if (!(e instanceof ReturnSignal)) throw e; }
    }
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
        n = readRetrying(desc.fd, buf, buf.length);
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
        n = readRetrying(fd, buf, 1);
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
    this.interrupted = false;
    try {
      return this.runSource(src, this.defaultIo());
    } catch (e) {
      if (e instanceof ExitSignal) { this.exited = true; return this.setStatus(e.status); }
      if (e instanceof InterruptSignal) return this.setStatus(e.status);
      // return outside a function ends the script, like zsh.
      if (e instanceof ReturnSignal) return this.setStatus(e.status);
      if (e instanceof BreakSignal || e instanceof ContinueSignal) {
        this.writeStderr(`maxshell: ${e instanceof BreakSignal ? 'break' : 'continue'}: not in a loop\n`);
        return this.setStatus(1);
      }
      throw e;
    } finally {
      this.flush();
    }
  }

  // Runs the EXIT trap, once, when the shell or script is finishing.
  runExitTrap() {
    const code = this.traps.get('EXIT');
    if (!code) return;
    this.traps.delete('EXIT');
    const status = this.status;
    try { this.run(code); } catch { /* the trap's own errors don't matter now */ }
    this.status = status;
  }

  // Runs the trap for a signal (INT, TERM, …) if one is set.
  runTrap(sig) {
    const code = this.traps.get(sig);
    if (!code) return false;
    const status = this.status;
    try { this.run(code); } catch (e) { if (!(e instanceof ShellError)) throw e; }
    this.status = status;
    return true;
  }

  // Checks first that the input is complete (so the REPL knows to keep
  // reading), then parses and runs one command at a time, as zsh does: an
  // alias defined on one line applies to the next, and a syntax error is
  // reported when it's reached.
  runSource(src, io) {
    const aliases = { aliases: this.aliases, galiases: this.galiases, saliases: this.saliases };
    try {
      new Parser(src, { aliases }).parseProgram();
    } catch (e) {
      if (e instanceof IncompleteError) throw e;
    }
    const parser = new Parser(src, { aliases });
    let status = this.status;
    for (;;) {
      const item = parser.parseNextItem();
      if (!item) break;
      status = this.exec(item, io || this.defaultIo());
    }
    return status;
  }

  parse(src) {
    return new Parser(src, { aliases: { aliases: this.aliases, galiases: this.galiases, saliases: this.saliases } }).parseProgram();
  }

  captureOutput(src) {
    const sink = { kind: 'capture', chunks: [] };
    const io = {
      stdin: this.curIo ? this.curIo.stdin : TERM_IN,
      stdout: sink,
      stderr: this.curIo ? this.curIo.stderr : TERM_ERR,
    };
    try {
      this.exec(this.parse(src), io);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
      this.status = e.status;
    }
    this.substStatus = this.status;
    return sink.chunks.join('');
  }

  // <(cmd) and =(cmd) run cmd now and hand over a file holding its output;
  // >(cmd) hands over a file and feeds what was written to cmd afterwards.
  // (Pipelines here are buffered, so a file stands in for a pipe.)
  processSubstitution(p) {
    if (!this.procDir) this.procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxshell-'));
    this.procCount = (this.procCount || 0) + 1;
    const file = path.join(this.procDir, `sub${this.procCount}`);
    if (p.dir === '>') {
      fs.writeFileSync(file, '');
      (this.pendingOutSubs || (this.pendingOutSubs = [])).push({ file, src: p.src });
    } else {
      fs.writeFileSync(file, this.captureOutput(p.src));
    }
    (this.procFiles || (this.procFiles = [])).push(file);
    return file;
  }

  // After a command: run any >(cmd) with what was written, then tidy up.
  finishProcessSubstitutions(io) {
    const pending = this.pendingOutSubs || [];
    this.pendingOutSubs = [];
    for (const { file, src } of pending) {
      let data = '';
      try { data = fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
      const status = this.status;
      this.exec(this.parse(src), { stdin: { kind: 'string', data, pos: 0 }, stdout: io.stdout, stderr: io.stderr });
      this.status = status;
    }
    for (const f of this.procFiles || []) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    this.procFiles = [];
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
      if (status !== 0 && this.condDepth === 0) {
        if (this.traps.has('ERR') && !this.inErrTrap) {
          this.inErrTrap = true;
          try { this.runTrap('ERR'); } finally { this.inErrTrap = false; }
        }
        if (this.options.has('e')) throw new ExitSignal(status);
      }
      if (this.interrupted) { this.interrupted = false; throw new InterruptSignal(status); }
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

  // Pipelines stream: runs of stages that are plain programs are handed to
  // the system shell as one real pipeline (so `tail -f log | grep x` and
  // `yes | head` work, and Ctrl-Z stops them all). Builtins and functions
  // in a pipeline still run here, joined to the rest through buffers.
  execPipeline(node, io) {
    const cmds = node.commands;
    let status;

    if (cmds.length === 1) {
      status = this.exec(cmds[0], io);
    } else {
      const plans = cmds.map((c) => this.externalStage(c));
      const statuses = [];
      let input = io.stdin;
      let i = 0;
      while (i < cmds.length) {
        let j = i;
        if (plans[i]) while (j + 1 < cmds.length && plans[j + 1]) j++;
        const last = j === cmds.length - 1;
        const sink = last ? io.stdout : { kind: 'capture', chunks: [] };
        if (j > i) {
          // Stages i..j are all programs: one streaming pipeline.
          const script = plans.slice(i, j + 1).map((p, k) => p + (cmds[i + k].pipeStderr && i + k < j ? ' 2>&1' : '')).join(' | ');
          const errSink = cmds[j].pipeStderr && !last ? sink : io.stderr;
          const pre = this.options.has('pipefail') && SH === '/bin/bash' ? 'set -o pipefail; ' : '';
          status = this.runExternal([SH, '-c', pre + script], { stdin: input, stdout: sink, stderr: errSink }, this.env);
          for (let k = i; k <= j; k++) statuses.push(status);
        } else {
          status = this.exec(cmds[i], {
            stdin: input,
            stdout: sink,
            stderr: cmds[i].pipeStderr ? sink : io.stderr,
          });
          statuses.push(status);
        }
        if (!last) input = { kind: 'string', data: sink.chunks.join(''), pos: 0 };
        if (this.interrupted) break;
        i = j + 1;
      }
      this.setVar('pipestatus', statuses.map(String));
      if (this.options.has('pipefail')) status = statuses.slice().reverse().find((x) => x !== 0) ?? 0;
    }

    if (node.negate) status = status === 0 ? 1 : 0;
    return this.setStatus(status);
  }

  // A pipeline stage as /bin/sh source, if it's a plain program with plain
  // redirections (expanding its words now); otherwise null.
  externalStage(cmd) {
    if (cmd.type !== 'Simple' || !cmd.words.length) return null;
    const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    for (const r of cmd.redirects) if (r.op === '<<' || r.op === '<<-' || r.op === '<<<') return null;
    if (cmd.words.some((w) => w.parts.some((p) => p.t === 'procsub' || p.t === 'cmd'))) return null;
    let argv;
    try { argv = this.expandCommandWords(cmd.words); } catch { return null; }
    if (!argv.length || argv.some((a) => typeof a !== 'string')) return null;
    const name = argv[0];
    // ls is a builtin only for its fancy terminal view; in a pipe it's ls.
    if (this.funcs.has(name) || (BUILTINS[name] && name !== 'ls')) return null;
    if (!findInPath(name, this)) return null;
    let out = '';
    for (const a of cmd.assigns) {
      if (a.array) return null;
      out += `${a.name}=${q(expandToString(this, a.value))} `;
    }
    out += argv.map(q).join(' ');
    for (const r of cmd.redirects) {
      const target = expandToString(this, r.target);
      const fd = r.fd === null ? '' : String(r.fd);
      switch (r.op) {
        case '<': out += ` ${fd}< ${q(this.resolve(target))}`; break;
        case '>': out += ` ${fd}> ${q(this.resolve(target))}`; break;
        case '>>': out += ` ${fd}>> ${q(this.resolve(target))}`; break;
        case '&>': out += ` > ${q(this.resolve(target))} 2>&1`; break;
        case '&>>': out += ` >> ${q(this.resolve(target))} 2>&1`; break;
        case '>&': case '<&':
          if (/^\d+$/.test(target) || target === '-') out += ` ${fd || (r.op === '>&' ? '1' : '0')}${r.op}${target}`;
          else out += ` > ${q(this.resolve(target))} 2>&1`;
          break;
        default: return null;
      }
    }
    return out;
  }

  // cmd &. With the job helper, the command runs in a process group of its
  // own and shows up in `jobs`; a single program runs directly, anything
  // else (a loop, a group, a pipeline) in a child maxshell that is handed
  // this shell's variables, functions and aliases.
  execBackground(node, io) {
    const single = node.type === 'Pipeline' && !node.negate && node.commands.length === 1
      ? node.commands[0]
      : null;
    let argv = null;
    let label = node.src || null;
    if (single && single.type === 'Simple' && !single.redirects.length && !single.assigns.length) {
      const words = expandWords(this, single.words);
      if (words.length && !this.funcs.has(words[0]) && !BUILTINS[words[0]] && findInPath(words[0], this)) argv = words;
    }
    if (!argv && node.src) {
      argv = [process.execPath, path.join(__dirname, '..', 'bin', 'maxshell.js'), '-c', `${this.serializeState()}\n${node.src}`];
    }
    if (!argv) return this.exec(node, io);
    if (!label) label = argv.join(' ');

    // Output being captured in memory can't come from a background job.
    const stdio = this.stdioFor(io, { background: true });
    // Scripts give background jobs no terminal input, as POSIX shells do.
    if (!this.interactive && stdio[0] === 'inherit') stdio[0] = 'ignore';
    const job = jobs.start(argv, { mode: 'bg', cwd: this.cwd, env: this.env, stdio, cmd: label });
    if (job) {
      this.addJob(job);
      this.lastBgPid = job.pgid || job.helperPid;
      if (this.interactive) this.writeStderr(`[${job.id}] ${this.lastBgPid}\n`);
      return this.setStatus(0);
    }
    try {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: this.cwd, env: this.env, stdio: 'ignore', detached: true,
      });
      child.unref();
      child.on('error', () => {});
      this.lastBgPid = child.pid;
      if (this.interactive) this.writeStderr(`[bg] ${child.pid}\n`);
      return this.setStatus(0);
    } catch {
      return this.exec(node, io);
    }
  }

  // The shell's variables, functions, aliases and options as source text,
  // for a child maxshell that runs part of this one in the background.
  serializeState() {
    const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    const lines = [];
    const skip = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
    for (const [name, entry] of this.vars) {
      if (skip.has(name) || entry.exported) continue;
      const v = entry.value;
      if (v instanceof Map) lines.push(`typeset -A ${name}; ${name}=(${[...v].flat().map(q).join(' ')})`);
      else if (Array.isArray(v)) lines.push(`${name}=(${v.map(q).join(' ')})`);
      else lines.push(`${name}=${q(v)}`);
      if (entry.integer) lines.push(`typeset -i ${name}`);
    }
    for (const fn of this.funcs.values()) if (fn.src) lines.push(fn.src);
    for (const [kind, flag] of [['aliases', ''], ['galiases', ' -g'], ['saliases', ' -s']]) {
      for (const [n, v] of this[kind]) lines.push(`alias${flag} ${n}=${q(v)}`);
    }
    const opts = [...this.options].filter((o) => o.length > 1 && o !== 'autocd');
    if (opts.length) lines.push(`setopt ${opts.join(' ')}`);
    if (this.positional.length) lines.push(`set -- ${this.positional.map(q).join(' ')}`);
    return lines.join('\n');
  }

  // --- jobs -----------------------------------------------------------------

  addJob(job) {
    let id = 1;
    while (this.jobs.some((j) => j.id === id)) id++;
    job.id = id;
    this.jobs.push(job);
    this.jobs.sort((a, b) => a.id - b.id);
    this.currentJob = job;
    return job;
  }

  removeJob(job) {
    this.jobs = this.jobs.filter((j) => j !== job);
    job.cleanup();
    if (this.currentJob === job) this.currentJob = this.jobs[this.jobs.length - 1] || null;
  }

  // %1, %%, %+, %-, %vim (starts with), %?make (contains); a bare pid too.
  findJob(spec) {
    if (spec === undefined || spec === '%%' || spec === '%+' || spec === '%') return this.currentJob || this.jobs[this.jobs.length - 1] || null;
    if (spec === '%-') return this.jobs.filter((j) => j !== this.currentJob).pop() || null;
    let m = /^%?(\d+)$/.exec(spec);
    if (m && spec.startsWith('%')) return this.jobs.find((j) => j.id === Number(m[1])) || null;
    m = /^\d+$/.exec(spec);
    if (m) return this.jobs.find((j) => j.pgid === Number(spec) || j.helperPid === Number(spec)) || null;
    if (spec.startsWith('%?')) return this.jobs.find((j) => j.cmd.includes(spec.slice(2))) || null;
    if (spec.startsWith('%')) return this.jobs.find((j) => j.cmd.startsWith(spec.slice(1))) || null;
    return null;
  }

  // "[1]  + suspended  vim notes.md" and friends.
  jobLine(job, { long = false } = {}) {
    job.poll();
    const mark = job === this.currentJob ? '+' : ' ';
    let state;
    if (job.state === 'stopped') state = job.signal === 21 || job.signal === 22 ? 'suspended (tty input)' : 'suspended';
    else if (job.state === 'running') state = 'running';
    else if (job.signal) state = job.signal === 2 ? 'interrupt' : job.signal === 15 ? 'terminated' : job.signal === 9 ? 'killed' : `signal ${job.signal}`;
    else state = job.code ? `exit ${job.code}` : 'done';
    const pid = long ? ` ${job.pgid || job.helperPid}` : '';
    return `[${job.id}]  ${mark}${pid} ${state.padEnd(10)} ${job.cmd}`;
  }

  // Before each prompt: report background jobs that finished or stopped.
  notifyJobs(write = (t) => this.writeStderr(t)) {
    for (const job of this.jobs.slice()) {
      const changed = job.poll();
      if (job.finished) {
        write(`${this.jobLine(job)}\n`);
        this.removeJob(job);
      } else if (changed && job.state === 'stopped' && !job.notified) {
        job.notified = true;
        write(`${this.jobLine(job)}\n`);
      } else if (job.state === 'running') job.notified = false;
    }
  }

  // Brings a job to the foreground and waits for it.
  foregroundJob(job, io) {
    this.currentJob = job;
    this.writeTo(io.stderr, `[${job.id}]  - continued  ${job.cmd}\n`);
    job.foreground();
    return this.settleForeground(job, io, true);
  }

  // After a foreground job stops or ends: keep it in the table if it stopped.
  settleForeground(job, io, known) {
    if (job.state === 'stopped') {
      if (!known) this.addJob(job);
      job.notified = true;
      this.writeTo(io.stderr, `\n${this.jobLine(job)}\n`);
      this.interrupted = true;
      this.suspended = true;
      return 128 + (job.signal || 20);
    }
    if (known) this.removeJob(job); else job.cleanup();
    if (job.signal === 2) {
      this.interrupted = true;
      this.writeTo(io.stderr, '\n');
    }
    return job.code ?? 0;
  }

  // Maps redirected io to what the helper's child gets, or null when the
  // output is being captured in memory (then there's no job to control).
  stdioFor(io, { background = false } = {}) {
    const one = (d, which) => {
      if (!d) return 'inherit';
      if (d.kind === 'file') return d.fd;
      if (d.kind === 'null') return 'ignore';
      if (d.kind === 'fd') return d.fd;
      if (d.kind === 'term') return (which === 'out' && this.output) || (which === 'err' && this.errorOutput) ? null : 'inherit';
      return null;
    };
    const stdio = [one(io.stdin, 'in'), one(io.stdout, 'out'), one(io.stderr, 'err')];
    if (background) return stdio.map((x) => x ?? 'ignore');
    return stdio.includes(null) ? null : stdio;
  }

  // Job control applies at an interactive terminal.
  jobControl() {
    return this.interactive && !this.output && !!process.stdin.isTTY && !!jobs.helperPath();
  }

  execRedirected(node, io) {
    // The outermost command owns any <(…) >(…) files made while running it.
    const outer = !this.inCommand;
    this.inCommand = true;
    let opened = [];
    const saved = this.curIo;
    try {
      const applied = this.applyRedirects(node.redirects, io);
      opened = applied.opened;
      this.curIo = applied.io;
      return this.execNode(node, applied.io);
    } finally {
      this.curIo = saved;
      for (const fd of opened) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      if (outer) {
        this.inCommand = false;
        if ((this.procFiles && this.procFiles.length) || (this.pendingOutSubs && this.pendingOutSubs.length)) this.finishProcessSubstitutions(io);
      }
    }
  }

  execNode(node, io) {
    switch (node.type) {
      case 'Simple': return this.execSimple(node, io);
      case 'Group': return this.exec(node.body, io);
      case 'Always': {
        let status;
        try {
          status = this.exec(node.body, io);
        } finally {
          const saved = this.status;
          this.exec(node.always, io);
          this.status = saved;
        }
        return this.setStatus(status);
      }
      case 'Subshell': return this.execSubshell(node, io);
      case 'If': return this.execIf(node, io);
      case 'While': return this.execWhile(node, io);
      case 'For': return this.execFor(node, io);
      case 'Select': return this.execSelect(node, io);
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
      vars: new Map([...this.vars].map(([k, v]) => [k, {
        ...v, value: Array.isArray(v.value) ? v.value.slice() : v.value instanceof Map ? new Map(v.value) : v.value,
      }])),
      env: { ...this.env },
      cwd: this.cwd,
      funcs: new Map(this.funcs),
      aliases: new Map(this.aliases),
      galiases: new Map(this.galiases),
      saliases: new Map(this.saliases),
      positional: this.positional.slice(),
      options: new Set(this.options),
      traps: new Map(this.traps),
    };
  }

  restore(s) {
    this.vars = s.vars;
    this.scopes = [this.vars];
    this.env = s.env;
    this.cwd = s.cwd;
    this.funcs = s.funcs;
    this.aliases = s.aliases;
    this.galiases = s.galiases;
    this.saliases = s.saliases;
    this.positional = s.positional;
    this.options = s.options;
    this.traps = s.traps;
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
    this.loopDepth++;
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
    } finally {
      this.loopDepth--;
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
    const names = node.names || [node.name];
    const state = { status: 0 };
    for (let i = 0; i < items.length; i += names.length) {
      names.forEach((n, k) => this.setVar(n, items[i + k] ?? ''));
      if (this.runIteration(node.body, io, state) === 'break') break;
    }
    return this.setStatus(state.status);
  }

  // select name in words: a numbered menu on stderr, read from stdin until
  // the body breaks or input ends.
  execSelect(node, io) {
    const items = node.items === null ? this.positional.slice() : expandWords(this, node.items);
    const state = { status: 0 };
    if (!items.length) return this.setStatus(0);
    const w = String(items.length).length;
    for (;;) {
      this.writeTo(io.stderr, `${items.map((it, i) => `${String(i + 1).padStart(w)}) ${it}`).join('\n')}\n`);
      this.writeTo(io.stderr, this.getVar('PROMPT3') ?? '?# ');
      const line = this.readLine(io.stdin);
      if (line === null) { this.writeTo(io.stderr, '\n'); break; }
      this.setVar('REPLY', line);
      const n = Number(line.trim());
      this.setVar(node.name, Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : '');
      if (!line.trim()) continue;
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
    let status = 0;
    let falling = false;
    let any = false;
    for (const clause of node.cases) {
      if (!falling && !clause.patterns.some((p) => matchPattern(expandToPattern(this, p), subject))) continue;
      any = true;
      status = this.exec(clause.body, io);
      falling = clause.fall;
      if (!clause.fall && !clause.cont) break;
    }
    return this.setStatus(any ? status : 0);
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
        if (node.op === '=~') {
          let re;
          try { re = new RegExp(expandToString(this, node.right)); } catch (e) {
            throw new ShellError(`bad regex: ${e.message.replace(/^Invalid regular expression: /, '')}`);
          }
          const m = re.exec(left);
          // zsh sets $MATCH and $match; bash's $BASH_REMATCH is there too.
          if (m) {
            this.setVar('MATCH', m[0]);
            this.setVar('MBEGIN', String(m.index + 1));
            this.setVar('MEND', String(m.index + m[0].length));
            this.setVar('match', m.slice(1).map((x) => x ?? ''));
            this.setVar('BASH_REMATCH', m.map((x) => x ?? ''));
          }
          return !!m;
        }
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

  doAssign(a) {
    const entry = this.findEntry(a.name);
    if (a.array && a.index !== null && a.index !== undefined && !(entry && entry.value instanceof Map)) {
      // a[2,3]=(x y) replaces a slice; a[2]=() removes an element.
      const values = expandWords(this, a.array);
      const arr = (this.getArray(a.name) || (this.getVar(a.name) !== undefined ? [this.getVar(a.name)] : [])).slice();
      const [from, to] = a.index.includes(',') ? a.index.split(',') : [a.index, a.index];
      const pos = (n) => (n < 0 ? arr.length + n + 1 : n);
      const i = Math.max(1, pos(Math.trunc(evalArith(from, this))));
      const j = pos(Math.trunc(evalArith(to, this)));
      while (arr.length < i - 1) arr.push('');
      arr.splice(i - 1, Math.max(0, j - i + 1), ...values);
      this.setArray(a.name, arr);
      return;
    }
    if (a.array) {
      const values = expandWords(this, a.array);
      if (entry && entry.value instanceof Map) {
        // h=(key value key value …)
        const m = a.append ? new Map(entry.value) : new Map();
        for (let i = 0; i < values.length; i += 2) m.set(values[i], values[i + 1] ?? '');
        this.setVar(a.name, m);
        return;
      }
      let current = [];
      if (a.append && entry) current = Array.isArray(entry.value) ? entry.value : [entry.value];
      else if (a.append && this.getVar(a.name) !== undefined) current = [this.getVar(a.name)];
      this.setArray(a.name, current.concat(values));
      return;
    }
    const value = expandToString(this, a.value);
    if (a.index !== null && a.index !== undefined) {
      if (entry && entry.value instanceof Map) {
        const key = expandToString(this, require('./lexer').lexWordParts(a.index));
        const m = new Map(entry.value);
        m.set(key, a.append ? (m.get(key) ?? '') + value : value);
        this.setVar(a.name, m);
        return;
      }
      const arr = (this.getArray(a.name) || (this.getVar(a.name) !== undefined ? [this.getVar(a.name)] : [])).slice();
      const n = Math.trunc(evalArith(a.index, this));
      const i = n < 0 ? arr.length + n : n - 1;
      if (i < 0) throw new ShellError(`${a.name}: assignment to invalid subscript range`);
      arr[i] = a.append ? (arr[i] ?? '') + value : value;
      for (let k = 0; k < arr.length; k++) if (arr[k] === undefined) arr[k] = '';
      this.setArray(a.name, arr);
      return;
    }
    if (a.append && entry && Array.isArray(entry.value)) { this.setArray(a.name, entry.value.concat([value])); return; }
    if (a.append && entry && (entry.integer || entry.float)) {
      this.setVar(a.name, String(evalArith(`(${entry.value || 0})+(${value || 0})`, this)));
      return;
    }
    this.setVar(a.name, a.append ? (this.getVar(a.name) ?? '') + value : value);
  }

  // Expands a command's words. Declaration builtins (typeset, local…) treat
  // name=value arguments as assignments: no splitting or globbing, and
  // name=(a b) passes an array.
  expandCommandWords(words) {
    const argv = [];
    const first = words.length ? expandWord(this, words[0]) : [];
    argv.push(...first);
    const declaring = DECLARERS.has(first[0]) && !words[0].quoted;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w.declArray) {
        argv.push({ name: w.declArray.name, append: w.declArray.append, values: expandWords(this, w.declArray.elems) });
        continue;
      }
      if (declaring && splitAssignment(w)) {
        const a = splitAssignment(w);
        const value = expandToString(this, a.value);
        argv.push(`${a.name}${a.index !== null ? `[${a.index}]` : ''}${a.append ? '+' : ''}=${value}`);
        continue;
      }
      argv.push(...expandWord(this, w));
    }
    return argv;
  }

  execSimple(node, io) {
    this.substStatus = null;
    const argv = this.expandCommandWords(node.words);

    if (argv.length === 0) {
      for (const a of node.assigns) this.doAssign(a);
      // `x=$(cmd)` reports cmd's status.
      return this.setStatus(this.substStatus ?? 0);
    }

    const overrides = {};
    for (const a of node.assigns) {
      overrides[a.name] = a.array
        ? expandWords(this, a.array).join(' ')
        : expandToString(this, a.value);
    }

    if (this.options.has('x')) this.writeStderr(`${this.getVar('PS4') ?? '+'} ${argv.map((x) => (typeof x === 'string' ? x : `${x.name}=(${x.values.join(' ')})`)).join(' ')}\n`);

    const name = argv[0];
    // %1 or %vim on its own brings that job back, as in zsh (%1 & continues it).
    if (typeof name === 'string' && name.startsWith('%') && this.jobs.length && this.findJob(name)) {
      return this.setStatus(this.dispatch(argv[1] === '&' ? 'bg' : 'fg', [argv[1] === '&' ? 'bg' : 'fg', name], io));
    }
    const isLocal = this.funcs.has(name) || !!BUILTINS[name];

    // AUTO_CD: a folder typed on its own goes there.
    if (!isLocal && argv.length === 1 && this.options.has('autocd') && !findInPath(name, this)) {
      try {
        if (fs.statSync(this.resolve(name.replace(/^~(?=$|\/)/, this.getVar('HOME') || os.homedir()))).isDirectory()) {
          return this.setStatus(this.dispatch('cd', ['cd', name], io));
        }
      } catch { /* not a folder */ }
    }

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
    const savedName = this.scriptName;
    const savedLoops = this.loopDepth;
    this.positional = argv.slice(1);
    // Inside a function $0 is its name (zsh's FUNCTION_ARGZERO).
    this.scriptName = name;
    this.funcDepth++;
    if (this.funcDepth > 1000) {
      this.funcDepth--;
      this.positional = savedPositional;
      this.scriptName = savedName;
      this.loopDepth = savedLoops;
      throw new ShellError(`${name}: maximum nested function level reached`);
    }
    this.scopes.push(new Map());
    try {
      return this.exec(fn.body, io);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.status;
      throw e;
    } finally {
      this.scopes.pop();
      this.funcDepth--;
      this.loopDepth = savedLoops;
      this.positional = savedPositional;
      this.scriptName = savedName;
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
    // At the terminal, programs run as jobs: Ctrl-Z suspends them and Ctrl-C
    // reaches only them.
    if (this.jobControl() && findInPath(argv[0], this)) {
      const jstdio = this.stdioFor(io);
      if (jstdio) {
        const job = jobs.start(argv, { mode: 'fg', cwd: this.cwd, env, stdio: jstdio, cmd: this.currentCommand || argv.join(' ') });
        if (job) {
          job.waitForeground();
          return this.settleForeground(job, io, false);
        }
      }
    }

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
    if (res.signal) {
      if (res.signal === 'SIGINT' && this.interactive) this.interrupted = true;
      return 128 + (os.constants.signals[res.signal] || 0);
    }
    return res.status ?? 0;
  }
}

module.exports = {
  readRetrying,
  Shell,
  ShellError,
  IncompleteError,
  ExitSignal,
  TERM_IN,
  TERM_OUT,
  TERM_ERR,
};
