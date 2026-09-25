'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { RESERVED } = require('./lexer');
const { BreakSignal, ContinueSignal, ReturnSignal, ExitSignal } = require('./signals');

function out(shell, io, text) { shell.writeTo(io.stdout, text); }
function err(shell, io, text) { shell.writeTo(io.stderr, text); }

function unescapeString(s) {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { r += s[i]; continue; }
    const c = s[++i];
    switch (c) {
      case 'n': r += '\n'; break;
      case 't': r += '\t'; break;
      case 'r': r += '\r'; break;
      case 'a': r += '\x07'; break;
      case 'b': r += '\b'; break;
      case 'f': r += '\f'; break;
      case 'v': r += '\v'; break;
      case 'e': r += '\x1b'; break;
      case '\\': r += '\\'; break;
      case '0': {
        const m = /^[0-7]{1,3}/.exec(s.slice(i + 1)) || [''];
        r += String.fromCharCode(parseInt(m[0] || '0', 8));
        i += m[0].length;
        break;
      }
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) { r += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else r += '\\x';
        break;
      }
      case undefined: r += '\\'; break;
      default: r += `\\${c}`;
    }
  }
  return r;
}

function pad(str, width, left, zero) {
  if (!width || str.length >= width) return str;
  const fill = (zero && !left ? '0' : ' ').repeat(width - str.length);
  return left ? str + fill : fill + str;
}

function formatPrintf(fmt, args) {
  let result = '';
  let ai = 0;
  let usedAny = false;

  do {
    let i = 0;
    let usedThisPass = false;
    while (i < fmt.length) {
      const c = fmt[i];
      if (c === '\\') {
        const chunk = /^\\(?:[ntrabfve\\]|0[0-7]{0,3}|x[0-9a-fA-F]{1,2})/.exec(fmt.slice(i));
        if (chunk) { result += unescapeString(chunk[0]); i += chunk[0].length; continue; }
        result += c;
        i++;
        continue;
      }
      if (c !== '%') { result += c; i++; continue; }
      if (fmt[i + 1] === '%') { result += '%'; i += 2; continue; }

      const m = /^%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdiufeggxXocb])/.exec(fmt.slice(i));
      if (!m) { result += c; i++; continue; }
      const [all, flags, widthS, precS, conv] = m;
      i += all.length;

      const arg = args[ai++];
      usedThisPass = true;
      usedAny = true;
      const width = widthS ? Number(widthS) : 0;
      const prec = precS === undefined ? undefined : Number(precS);
      const left = flags.includes('-');
      const zero = flags.includes('0');
      const plus = flags.includes('+');

      let text;
      switch (conv) {
        case 's':
          text = arg === undefined ? '' : String(arg);
          if (prec !== undefined) text = text.slice(0, prec);
          break;
        case 'b':
          text = unescapeString(arg === undefined ? '' : String(arg));
          break;
        case 'c':
          text = (arg === undefined ? '' : String(arg)).slice(0, 1);
          break;
        case 'd': case 'i': case 'u': {
          const n = Math.trunc(Number(arg) || 0);
          text = String(Math.abs(n));
          if (prec !== undefined) text = text.padStart(prec, '0');
          text = (n < 0 ? '-' : plus ? '+' : '') + text;
          break;
        }
        case 'f': case 'e': case 'g': {
          const n = Number(arg) || 0;
          const p = prec === undefined ? 6 : prec;
          text = conv === 'f' ? n.toFixed(p) : conv === 'e' ? n.toExponential(p) : String(n);
          if (plus && n >= 0) text = `+${text}`;
          break;
        }
        case 'x': case 'X': case 'o': {
          const n = Math.trunc(Number(arg) || 0);
          text = n.toString(conv === 'o' ? 8 : 16);
          if (conv === 'X') text = text.toUpperCase();
          break;
        }
        default:
          text = '';
      }
      result += pad(text, width, left, zero);
    }
    if (!usedThisPass) break;
  } while (ai < args.length && usedAny);

  return result;
}

// --- test / [[ ]] primitives ------------------------------------------------

function statOf(shell, p) {
  try { return fs.statSync(shell.resolve(p)); } catch { return null; }
}

function testUnary(op, operand, shell) {
  switch (op) {
    case '-z': return operand.length === 0;
    case '-n': return operand.length > 0;
    case '-t': return process.stdout.isTTY === true;
    case '-o': return shell.options.has(operand);
    case '-v': return shell.getVar(operand) !== undefined;
    default: break;
  }
  const st = statOf(shell, operand);
  switch (op) {
    case '-e': case '-a': return st !== null;
    case '-f': return !!st && st.isFile();
    case '-d': return !!st && st.isDirectory();
    case '-s': return !!st && st.size > 0;
    case '-b': return !!st && st.isBlockDevice();
    case '-c': return !!st && st.isCharacterDevice();
    case '-p': return !!st && st.isFIFO();
    case '-S': return !!st && st.isSocket();
    case '-L': case '-h': {
      try { return fs.lstatSync(shell.resolve(operand)).isSymbolicLink(); } catch { return false; }
    }
    case '-r': case '-w': case '-x': {
      const mode = { '-r': fs.constants.R_OK, '-w': fs.constants.W_OK, '-x': fs.constants.X_OK }[op];
      try { fs.accessSync(shell.resolve(operand), mode); return true; } catch { return false; }
    }
    default: return false;
  }
}

function testBinary(op, l, r, shell) {
  switch (op) {
    case '=': case '==': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '>': return l > r;
    case '-eq': return Number(l) === Number(r);
    case '-ne': return Number(l) !== Number(r);
    case '-lt': return Number(l) < Number(r);
    case '-le': return Number(l) <= Number(r);
    case '-gt': return Number(l) > Number(r);
    case '-ge': return Number(l) >= Number(r);
    case '-nt': {
      const a = statOf(shell, l); const b = statOf(shell, r);
      return !!a && (!b || a.mtimeMs > b.mtimeMs);
    }
    case '-ot': {
      const a = statOf(shell, l); const b = statOf(shell, r);
      return !!b && (!a || a.mtimeMs < b.mtimeMs);
    }
    case '-ef': {
      const a = statOf(shell, l); const b = statOf(shell, r);
      return !!a && !!b && a.ino === b.ino && a.dev === b.dev;
    }
    default: return false;
  }
}

const UNARY_OPS = new Set(['-e', '-a', '-f', '-d', '-s', '-b', '-c', '-p', '-S', '-L', '-h',
  '-r', '-w', '-x', '-z', '-n', '-t', '-o', '-v']);
const BINARY_OPS = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge',
  '-nt', '-ot', '-ef']);

function evalTest(args, shell) {
  let i = 0;
  const peek = () => args[i];

  function orExpr() {
    let v = andExpr();
    while (peek() === '-o') { i++; const r = andExpr(); v = v || r; }
    return v;
  }
  function andExpr() {
    let v = notExpr();
    while (peek() === '-a') { i++; const r = notExpr(); v = v && r; }
    return v;
  }
  function notExpr() {
    if (peek() === '!') { i++; return !notExpr(); }
    return primary();
  }
  function primary() {
    if (peek() === '(') {
      i++;
      const v = orExpr();
      if (peek() === ')') i++;
      return v;
    }
    if (UNARY_OPS.has(peek()) && args.length > i + 1) {
      const op = args[i];
      const operand = args[i + 1];
      i += 2;
      return testUnary(op, operand, shell);
    }
    const left = args[i++];
    if (left === undefined) return false;
    if (BINARY_OPS.has(peek())) {
      const op = args[i++];
      const right = args[i++] ?? '';
      return testBinary(op, left, right, shell);
    }
    return left.length > 0;
  }

  return orExpr();
}

// --- helpers ----------------------------------------------------------------

function findInPath(name, shell) {
  if (name.includes('/')) {
    const p = shell.resolve(name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; }
  }
  const dirs = (shell.env.PATH || '').split(':').filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; }
    } catch { /* keep looking */ }
  }
  return null;
}

const HELP_TEXT = `maxshell — a zsh-flavoured shell language on Node.js

Syntax
  cmd a b c                 run a command with arguments
  cmd1 | cmd2               pipeline
  cmd1 && cmd2 || cmd3      run on success / on failure
  cmd &                     run in the background
  > file  >> file  < file   redirect stdout / append / stdin
  2> file  &> file  <<< str redirect stderr / both / here-string
  <<EOF ... EOF             here-document

Parameters
  name=value                assign          name=(a b c)   array (1-indexed)
  $name  \${name}  \${name:-d} expand with default
  \${#name}  \${name#pat}  \${name%pat}  \${name/a/b}  \${name:0:3}
  $(cmd)  \`cmd\`             command substitution
  $((expr))  ((expr))       arithmetic
  $?  $#  $@  $0 .. $9      status, arg count, all args, positional args

Control flow
  if cmd; then ...; elif cmd; then ...; else ...; fi
  for x in a b c; do ...; done        for ((i=0;i<3;i++)); do ...; done
  while cmd; do ...; done             until cmd; do ...; done
  repeat 3 do ...; done               foreach x (a b c) ... end
  case $x in a) ...;; b|c) ...;; *) ...;; esac
  name() { ...; }                     function name { ...; }
  [[ -f file && $x == pat* ]]         conditional expression

Builtins
  :  .  alias  bg-style jobs  break  cd  command  continue  declare  dirs
  echo  eval  exit  export  false  help  history  let  local  popd  print
  printf  pushd  pwd  pyedit  read  return  set  shift  source  test  true
  type  typeset  unalias  unfunction  unset  whence  which  [

Editing
  pyedit [file]             nano-style Python editor: highlighting, auto-indent,
                            selection and block indent, ^T runs the buffer
  gitui                     browse the repository: stage, diff, commit and push
  edit [file]               the same editor for JS, shell, JSON and Markdown too
  view [file] | ... | view  pager with highlighting, search and follow (F)
  files [dir]               file browser with previews; q leaves you in that dir
  top                       live process monitor: sort, filter, k to kill

Getting around
  j words…                  jump to your most-used folder matching the words
  back / forward            walk your folder history, like a browser
  Ctrl-R                    fuzzy-search every command you've run

Anything that is not a builtin or a function runs as a real program.
Type 'help' for this list, or 'type NAME' to see what a name refers to.
`;

// --- builtins ---------------------------------------------------------------

const BUILTINS = {};

BUILTINS[':'] = () => 0;
BUILTINS.true = () => 0;
BUILTINS.false = () => 1;

BUILTINS.echo = (args, io, shell) => {
  let newline = true;
  let escapes = true;
  let i = 0;
  while (i < args.length && /^-[neE]+$/.test(args[i])) {
    if (args[i].includes('n')) newline = false;
    if (args[i].includes('e')) escapes = true;
    if (args[i].includes('E')) escapes = false;
    i++;
  }
  const body = args.slice(i).map((a) => (escapes ? unescapeString(a) : a)).join(' ');
  out(shell, io, body + (newline ? '\n' : ''));
  return 0;
};

BUILTINS.print = (args, io, shell) => {
  let newline = true;
  let perLine = false;
  let raw = false;
  let i = 0;
  while (i < args.length && /^-[nlr]+$/.test(args[i])) {
    if (args[i].includes('n')) newline = false;
    if (args[i].includes('l')) perLine = true;
    if (args[i].includes('r')) raw = true;
    i++;
  }
  const items = args.slice(i).map((a) => (raw ? a : unescapeString(a)));
  const body = perLine ? items.map((s) => `${s}\n`).join('') : items.join(' ') + (newline ? '\n' : '');
  out(shell, io, body);
  return 0;
};

BUILTINS.printf = (args, io, shell) => {
  if (!args.length) { err(shell, io, 'printf: not enough arguments\n'); return 1; }
  out(shell, io, formatPrintf(args[0], args.slice(1)));
  return 0;
};

BUILTINS.cd = (args, io, shell) => {
  let target = args[0];
  if (!target) target = shell.getVar('HOME') || os.homedir();
  else if (target === '-') {
    target = shell.getVar('OLDPWD');
    if (!target) { err(shell, io, 'cd: OLDPWD not set\n'); return 1; }
    out(shell, io, `${target}\n`);
  }
  try {
    shell.setCwd(target);
    return 0;
  } catch (e) {
    err(shell, io, `cd: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}: ${args[0]}\n`);
    return 1;
  }
};

// `j words…` jumps to the most-used folder matching the words, learned from
// where you actually go. `j -l words` lists the candidates.
BUILTINS.j = (args, io, shell) => {
  const { DirDB } = require('./jump');
  let list = false;
  const words = [];
  for (const a of args) {
    if (a === '-l' || a === '--list') list = true;
    else words.push(a);
  }
  if (!words.length && !list) {
    try { shell.setCwd(shell.getVar('HOME') || os.homedir()); return 0; } catch { return 1; }
  }
  if (words.length === 1 && words[0] === '-') return BUILTINS.back([], io, shell);

  // A real path still works, like cd.
  if (!list && words.length === 1) {
    const direct = shell.resolve(words[0].replace(/^~(?=$|\/)/, shell.getVar('HOME') || os.homedir()));
    try {
      if (fs.statSync(direct).isDirectory()) { shell.setCwd(direct); return 0; }
    } catch { /* not a path: search instead */ }
  }

  const db = new DirDB();
  const hits = db.query(words, { cwd: shell.cwd });
  db.save();
  if (list) {
    if (!hits.length) { err(shell, io, `j: nothing matches ${words.join(' ')}\n`); return 1; }
    for (const h of hits.slice(0, 20)) out(shell, io, `${h.score.toFixed(1).padStart(7)}  ${h.path}\n`);
    return 0;
  }
  if (!hits.length) {
    err(shell, io, `j: no folder you've visited matches “${words.join(' ')}” (cd there once and j will remember it)\n`);
    return 1;
  }
  try {
    shell.setCwd(hits[0].path);
  } catch (e) {
    err(shell, io, `j: ${e.message}\n`);
    return 1;
  }
  out(shell, io, `${hits[0].path}\n`);
  return 0;
};

// Browser-style folder history: every directory change can be walked back.
BUILTINS.back = (args, io, shell) => {
  const steps = Math.max(1, Number(args[0]) || 1);
  for (let i = 0; i < steps; i++) {
    const dir = shell.dirBack.pop();
    if (!dir) { if (i === 0) { err(shell, io, 'back: no earlier folder\n'); return 1; } break; }
    const from = shell.cwd;
    try { shell.setCwd(dir, { record: false }); } catch { continue; }
    shell.dirForward.push(from);
  }
  out(shell, io, `${shell.cwd}\n`);
  return 0;
};

BUILTINS.forward = (args, io, shell) => {
  const steps = Math.max(1, Number(args[0]) || 1);
  for (let i = 0; i < steps; i++) {
    const dir = shell.dirForward.pop();
    if (!dir) { if (i === 0) { err(shell, io, 'forward: no later folder\n'); return 1; } break; }
    const from = shell.cwd;
    try { shell.setCwd(dir, { record: false }); } catch { continue; }
    shell.dirBack.push(from);
  }
  out(shell, io, `${shell.cwd}\n`);
  return 0;
};

BUILTINS.pwd = (args, io, shell) => { out(shell, io, `${shell.cwd}\n`); return 0; };

BUILTINS.pushd = (args, io, shell) => {
  const prev = shell.cwd;
  const target = args[0] || shell.dirStack[0];
  if (!target) { err(shell, io, 'pushd: no other directory\n'); return 1; }
  try { shell.setCwd(target); } catch { err(shell, io, `pushd: no such directory: ${target}\n`); return 1; }
  shell.dirStack.unshift(prev);
  out(shell, io, `${[shell.cwd, ...shell.dirStack].join(' ')}\n`);
  return 0;
};

BUILTINS.popd = (args, io, shell) => {
  const target = shell.dirStack.shift();
  if (!target) { err(shell, io, 'popd: directory stack empty\n'); return 1; }
  try { shell.setCwd(target); } catch { return 1; }
  out(shell, io, `${[shell.cwd, ...shell.dirStack].join(' ')}\n`);
  return 0;
};

BUILTINS.dirs = (args, io, shell) => {
  out(shell, io, `${[shell.cwd, ...shell.dirStack].join(' ')}\n`);
  return 0;
};

BUILTINS.export = (args, io, shell) => {
  if (!args.length) {
    for (const [name, entry] of shell.vars) {
      if (entry.exported) out(shell, io, `export ${name}=${JSON.stringify(String(entry.value))}\n`);
    }
    return 0;
  }
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq === -1) shell.exportVar(a);
    else { shell.setVar(a.slice(0, eq), a.slice(eq + 1)); shell.exportVar(a.slice(0, eq)); }
  }
  return 0;
};

BUILTINS.unset = (args, io, shell) => {
  for (const a of args) { shell.unsetVar(a); shell.funcs.delete(a); }
  return 0;
};

BUILTINS.unfunction = (args, io, shell) => {
  for (const a of args) shell.funcs.delete(a);
  return 0;
};

function declareLike(args, io, shell, forceLocal) {
  const scope = forceLocal && shell.scopes.length > 1
    ? shell.scopes[shell.scopes.length - 1]
    : shell.vars;
  const names = args.filter((a) => !a.startsWith('-'));
  if (!names.length) {
    for (const [name, entry] of shell.vars) {
      out(shell, io, `${name}=${Array.isArray(entry.value) ? `(${entry.value.join(' ')})` : entry.value}\n`);
    }
    return 0;
  }
  for (const a of names) {
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? '' : a.slice(eq + 1);
    scope.set(name, { value, exported: false });
  }
  return 0;
}

BUILTINS.local = (args, io, shell) => declareLike(args, io, shell, true);
BUILTINS.typeset = (args, io, shell) => declareLike(args, io, shell, true);
BUILTINS.declare = (args, io, shell) => declareLike(args, io, shell, false);

BUILTINS.alias = (args, io, shell) => {
  if (!args.length) {
    for (const [name, value] of [...shell.aliases].sort()) {
      out(shell, io, `alias ${name}=${JSON.stringify(value)}\n`);
    }
    return 0;
  }
  let status = 0;
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq === -1) {
      if (shell.aliases.has(a)) out(shell, io, `alias ${a}=${JSON.stringify(shell.aliases.get(a))}\n`);
      else { err(shell, io, `alias: ${a} not found\n`); status = 1; }
    } else {
      shell.aliases.set(a.slice(0, eq), a.slice(eq + 1));
    }
  }
  return status;
};

BUILTINS.unalias = (args, io, shell) => {
  for (const a of args) shell.aliases.delete(a);
  return 0;
};

BUILTINS.history = (args, io, shell) => {
  const limit = args[0] ? Number(args[0]) : shell.history.length;
  const start = Math.max(0, shell.history.length - limit);
  shell.history.slice(start).forEach((line, i) => {
    out(shell, io, `${String(start + i + 1).padStart(5)}  ${line}\n`);
  });
  return 0;
};

BUILTINS.help = (args, io, shell) => { out(shell, io, HELP_TEXT); return 0; };

BUILTINS.shift = (args, io, shell) => {
  const n = args.length ? Number(args[0]) : 1;
  if (n > shell.positional.length) return 1;
  shell.positional = shell.positional.slice(n);
  return 0;
};

BUILTINS.exit = (args, io, shell) => {
  throw new ExitSignal(args.length ? Number(args[0]) & 0xff : shell.status);
};

BUILTINS.return = (args, io, shell) => {
  throw new ReturnSignal(args.length ? Number(args[0]) & 0xff : shell.status);
};

BUILTINS.break = (args) => { throw new BreakSignal(args.length ? Number(args[0]) : 1); };
BUILTINS.continue = (args) => { throw new ContinueSignal(args.length ? Number(args[0]) : 1); };

BUILTINS.test = (args, io, shell) => (evalTest(args, shell) ? 0 : 1);
BUILTINS['['] = (args, io, shell) => {
  const a = args.slice();
  if (a[a.length - 1] !== ']') { err(shell, io, "[: missing ']'\n"); return 2; }
  a.pop();
  return evalTest(a, shell) ? 0 : 1;
};

BUILTINS.let = (args, io, shell) => {
  const { evalArith } = require('./arith');
  let last = 0;
  for (const a of args) last = evalArith(a, shell);
  return last ? 0 : 1;
};

BUILTINS.eval = (args, io, shell) => shell.runSource(args.join(' '), io);

BUILTINS.source = (args, io, shell) => {
  if (!args.length) { err(shell, io, 'source: filename argument required\n'); return 1; }
  const file = shell.resolve(args[0]);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch {
    err(shell, io, `source: no such file or directory: ${args[0]}\n`);
    return 1;
  }
  const saved = shell.positional;
  if (args.length > 1) shell.positional = args.slice(1);
  try { return shell.runSource(src, io); } finally { shell.positional = saved; }
};
BUILTINS['.'] = BUILTINS.source;

BUILTINS.read = (args, io, shell) => {
  let raw = false;
  let prompt = null;
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i].length > 1) {
    const flag = args[i];
    if (flag === '-r') { raw = true; i++; continue; }
    if (flag === '-p') { prompt = args[i + 1] ?? ''; i += 2; continue; }
    if (flag.startsWith('-p')) { prompt = flag.slice(2); i++; continue; }
    break;
  }
  if (prompt !== null) err(shell, io, prompt);

  const line = shell.readLine(io.stdin);
  if (line === null) return 1;
  const text = raw ? line : line.replace(/\\(.)/g, '$1');

  const names = args.slice(i);
  if (!names.length) { shell.setVar('REPLY', text); return 0; }

  const ifs = shell.getVar('IFS') ?? ' \t\n';
  const fields = text.split(new RegExp(`[${ifs.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]+`)).filter((f, idx, arr) => !(f === '' && (idx === 0 || idx === arr.length - 1)));
  names.forEach((name, idx) => {
    if (idx === names.length - 1) shell.setVar(name, fields.slice(idx).join(' '));
    else shell.setVar(name, fields[idx] ?? '');
  });
  return 0;
};

BUILTINS.set = (args, io, shell) => {
  if (!args.length) {
    for (const [name, entry] of [...shell.vars].sort()) {
      out(shell, io, `${name}=${Array.isArray(entry.value) ? `(${entry.value.join(' ')})` : entry.value}\n`);
    }
    return 0;
  }
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (a === '-o' || a === '+o') {
      const name = args[++i];
      if (!name) continue;
      if (a === '-o') shell.options.add(name); else shell.options.delete(name);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) { for (const f of a.slice(1)) shell.options.add(f); continue; }
    if (a.startsWith('+') && a.length > 1) { for (const f of a.slice(1)) shell.options.delete(f); continue; }
    break;
  }
  if (i < args.length || args.includes('--')) shell.positional = args.slice(i);
  return 0;
};

BUILTINS.command = (args, io, shell) => {
  if (!args.length) return 0;
  const argv = args.filter((a) => a !== '-p');
  return shell.runExternal(argv, io, shell.env);
};

BUILTINS.jobs = (args, io, shell) => {
  shell.jobs.forEach((j, i) => out(shell, io, `[${i + 1}]  ${j.pid}  ${j.cmd}\n`));
  return 0;
};

function describe(name, shell, verbose) {
  if (shell.aliases.has(name)) return `${name} is an alias for ${shell.aliases.get(name)}`;
  if (shell.funcs.has(name)) return `${name} is a shell function`;
  if (RESERVED.has(name)) return `${name} is a reserved word`;
  if (BUILTINS[name]) return `${name} is a shell builtin`;
  const p = findInPath(name, shell);
  if (p) return verbose ? `${name} is ${p}` : p;
  return null;
}

BUILTINS.type = (args, io, shell) => {
  let status = 0;
  for (const a of args) {
    const d = describe(a, shell, true);
    if (d) out(shell, io, `${d}\n`);
    else { err(shell, io, `type: ${a} not found\n`); status = 1; }
  }
  return status;
};

BUILTINS.whence = BUILTINS.type;

BUILTINS.gitui = (args, io, shell) => {
  const { runGitUI } = require('./gitui');
  return runGitUI(args, io, shell);
};

BUILTINS.pyedit = (args, io, shell) => {
  const { runEditor } = require('./pyedit');
  return runEditor(args, io, shell, { tool: 'pyedit', lang: 'python' });
};

BUILTINS.edit = (args, io, shell) => {
  const { runEditor } = require('./pyedit');
  return runEditor(args, io, shell, { tool: 'edit' });
};

BUILTINS.view = (args, io, shell) => {
  const { runView } = require('./view');
  return runView(args, io, shell);
};

BUILTINS.files = (args, io, shell) => {
  const { runFiles } = require('./files');
  return runFiles(args, io, shell);
};

BUILTINS.top = (args, io, shell) => {
  const { runTop } = require('./top');
  return runTop(args, io, shell);
};

BUILTINS.which = (args, io, shell) => {
  let status = 0;
  for (const a of args) {
    const d = describe(a, shell, false);
    if (d) out(shell, io, `${d}\n`);
    else { err(shell, io, `which: ${a} not found\n`); status = 1; }
  }
  return status;
};

module.exports = {
  BUILTINS,
  HELP_TEXT,
  testUnary,
  testBinary,
  unescapeString,
  formatPrintf,
  findInPath,
};
