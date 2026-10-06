'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { RESERVED } = require('./lexer');
const { BreakSignal, ContinueSignal, ReturnSignal, ExitSignal } = require('./signals');

function out(shell, io, text) { shell.writeTo(io.stdout, text); }
function err(shell, io, text) { shell.writeTo(io.stderr, text); }

// \c in echo/print ends the output there, newline included.
const STOP = '\uE000';
function stopAtC(body) {
  const at = body.indexOf(STOP);
  return at === -1 ? null : body.slice(0, at);
}

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
      case 'e': case 'E': r += '\x1b'; break;
      case '\\': r += '\\'; break;
      case 'c': return r + STOP;
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

      const m = /^%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?([sdiufeEgGxXocbq])/.exec(fmt.slice(i));
      if (!m) { result += c; i++; continue; }
      const [all, flags, widthS0, precS0, conv] = m;
      i += all.length;
      const widthS = widthS0 === '*' ? String(Number(args[ai++]) || 0) : widthS0;
      const precS = precS0 === '*' ? String(Number(args[ai++]) || 0) : precS0;

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
          text = [...(arg === undefined ? '' : String(arg))].slice(0, 1).join('');
          break;
        case 'q': {
          const v = arg === undefined ? '' : String(arg);
          text = v === '' ? "''" : /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : v.replace(/[^A-Za-z0-9_@%+=:,./-]/g, (ch) => (ch === '\n' ? "$'\\n'" : `\\${ch}`));
          break;
        }
        case 'd': case 'i': case 'u': {
          // A leading quote gives the character's code, as in printf(1).
          const n = /^['"]./.test(arg || '') ? arg.codePointAt(1) : Math.trunc(Number(arg) || 0);
          text = String(Math.abs(n));
          if (prec !== undefined) text = text.padStart(prec, '0');
          text = (n < 0 ? '-' : plus ? '+' : '') + text;
          break;
        }
        case 'f': case 'e': case 'E': case 'g': case 'G': {
          const n = Number(arg) || 0;
          const p = prec === undefined ? 6 : prec;
          if (conv === 'f') text = n.toFixed(p);
          else if (conv === 'e' || conv === 'E') text = n.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2');
          else text = String(Number(n.toPrecision(p || 1)));
          if (conv === 'E' || conv === 'G') text = text.toUpperCase();
          if (plus && n >= 0) text = `+${text}`;
          break;
        }
        case 'x': case 'X': case 'o': {
          const n = Math.trunc(Number(arg) || 0);
          text = (n < 0 ? BigInt.asUintN(64, BigInt(n)) : BigInt(n)).toString(conv === 'o' ? 8 : 16);
          if (conv === 'X') text = text.toUpperCase();
          if (flags.includes('#') && n !== 0) text = (conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X') + text;
          break;
        }
        default:
          text = '';
      }
      result += pad(text, width, left, zero);
    }
    if (!usedThisPass) break;
  } while (ai < args.length && usedAny);

  const cut = stopAtC(result);
  return cut !== null ? cut : result;
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
  $file:t  :h :r :e :u :l   \${(U)x}  \${(j:,:)arr}  \${(s:,:)x}  \${(k)hash}
  {a,b}  {1..10}            brace expansion       <(cmd)  process substitution
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
  :  .  alias  break  builtin  cd  command  continue  declare  dirs  echo
  emulate  eval  exit  export  false  float  getopts  help  history  integer
  jobs  let  local  popd  print  printf  pushd  pwd  read  readonly  return
  set  setopt  shift  source  test  trap  true  type  typeset  unalias
  unfunction  unset  unsetopt  whence  where  which  [

Editing
  pyedit [file]             nano-style Python editor: highlighting, auto-indent,
                            selection and block indent, ^T runs the buffer
  gitui                     browse the repository: stage, diff, commit and push
  edit [file]               the same editor for JS, shell, JSON and Markdown too
  view [file] | ... | view  pager with highlighting, search and follow (F)
  files [dir]               file browser with previews; q leaves you in that dir
  top                       live process monitor: sort, filter, k to kill

Getting around
  Ctrl-P  /  palette        the command palette: anything, searchable
  Alt-H  /  explain 'cmd'   what a command line will do, from the manuals
  dash                      live dashboard: git, jobs, CPU, memory, recent
  Alt-S  /  snip            save and reuse command snippets
  mark [name]  /  go        bookmark folders and jump back to them
  cleanup [-r|-c]           quit what isn't needed; then free memory / CPU
  6-7                       brainrot mode (6-7 again to stop)
  bot [question]            chat with a (fake, rules-only) bot
  ai [question]             chat with mx, a small AI model running on this Mac
  j words…                  jump to your most-used folder matching the words
  back / forward            walk your folder history, like a browser
  Ctrl-R                    fuzzy-search every command you've run

Looks
  theme [name]              list the colour themes, or switch to one (remembered)
  ls [-la] [--tree]         icons, colours and git status (the real ls in scripts)

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
  const cut = stopAtC(body);
  out(shell, io, cut !== null ? cut : body + (newline ? '\n' : ''));
  return 0;
};

BUILTINS.print = (args, io, shell) => {
  let newline = true;
  let perLine = false;
  let raw = false;
  let nul = false;
  let promptExp = false;
  let format = null;
  let toVar = null;
  let i = 0;
  while (i < args.length && /^-[nlrNPRcfv-]*$/.test(args[i]) && args[i] !== '-') {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (a === '-R') { raw = true; i++; break; }
    if (a.includes('f')) { format = args[i + 1] ?? ''; i += 2; continue; }
    if (a.includes('v')) { toVar = args[i + 1]; i += 2; continue; }
    if (a.includes('n')) newline = false;
    if (a.includes('l')) perLine = true;
    if (a.includes('r')) raw = true;
    if (a.includes('N')) nul = true;
    if (a.includes('P')) promptExp = true;
    i++;
  }
  let items = args.slice(i);
  let body;
  if (format !== null) body = formatPrintf(format, items);
  else {
    if (promptExp) {
      const { expandPrompt } = require('./prompt');
      items = items.map((a) => expandPrompt(a, shell));
    }
    items = items.map((a) => (raw ? a : unescapeString(a)));
    if (nul) body = items.map((x) => `${x}\0`).join('');
    else body = perLine ? items.map((x) => `${x}\n`).join('') : items.join(' ') + (newline ? '\n' : '');
  }
  const cut = stopAtC(body);
  if (cut !== null) body = cut;
  if (toVar) { shell.setVar(toVar, body.replace(/\n$/, '')); return 0; }
  out(shell, io, body);
  return 0;
};
BUILTINS.printf = (args, io, shell) => {
  let toVar = null;
  if (args[0] === '-v') { toVar = args[1]; args = args.slice(2); }
  if (args[0] === '--') args = args.slice(1);
  if (!args.length) { err(shell, io, 'printf: not enough arguments\n'); return 1; }
  const text = formatPrintf(args[0], args.slice(1));
  if (toVar) shell.setVar(toVar, text); else out(shell, io, text);
  return 0;
};

BUILTINS.cd = (args, io, shell) => {
  let physical = false;
  while (args.length && /^-[LP]+$/.test(args[0])) { physical = args[0].includes('P'); args = args.slice(1); }
  if (args[0] === '--') args = args.slice(1);
  let target = args[0];
  let announce = false;
  if (args.length === 2) {
    // zsh's two-argument cd: replace old with new in the current path.
    if (!shell.cwd.includes(args[0])) { err(shell, io, `cd: string not in pwd: ${args[0]}\n`); return 1; }
    target = shell.cwd.replace(args[0], args[1]);
    announce = true;
  } else if (args.length > 2) {
    err(shell, io, 'cd: too many arguments\n');
    return 1;
  }
  if (!target) target = shell.getVar('HOME') || os.homedir();
  else if (target === '-') {
    target = shell.getVar('OLDPWD');
    if (!target) { err(shell, io, 'cd: OLDPWD not set\n'); return 1; }
    announce = true;
  } else if (!target.startsWith('/') && !target.startsWith('.') && !target.startsWith('~')) {
    // CDPATH: folders to look in for a relative name.
    const cdpath = shell.getArray('cdpath') || (shell.getVar('CDPATH') || '').split(':').filter(Boolean);
    const here = shell.resolve(target);
    let isHere = false;
    try { isHere = fs.statSync(here).isDirectory(); } catch { /* not here */ }
    if (!isHere) {
      for (const base of cdpath) {
        const cand = path.resolve(shell.resolve(base), target);
        try { if (fs.statSync(cand).isDirectory()) { target = cand; announce = true; break; } } catch { /* keep looking */ }
      }
    }
  }
  try {
    shell.setCwd(target, { physical });
    if (announce && shell.interactive) out(shell, io, `${shell.cwd}\n`);
    return 0;
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'no such file or directory'
      : e.code === 'ENOTDIR' ? 'not a directory'
        : e.code === 'EACCES' ? 'permission denied' : e.message;
    err(shell, io, `cd: ${why}: ${args[args.length - 1] ?? target}\n`);
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

// `theme` lists the colour schemes with a preview of each; `theme name`
// switches to one everywhere and remembers it.
BUILTINS.theme = (args, io, shell) => {
  const theme = require('./theme');
  const ansiMod = require('./ansi');
  const name = args.find((a) => !a.startsWith('-'));

  if (!name) {
    const { highlight } = require('./highlight');
    const sample = 'git push origin main  # ship it';
    for (const n of theme.names()) {
      const t = theme.THEMES[n];
      const mark = n === theme.currentThemeName() ? '●' : ' ';
      if (!ansiMod.isEnabled()) {
        out(shell, io, `${mark} ${n.padEnd(12)} ${t.description}\n`);
        continue;
      }
      const line = theme.withTheme(n, () => {
        const swatch = t.gradient.slice(0, 6).map((c) => `${ansiMod.fg(c)}██`).join('') + ansiMod.reset();
        const name12 = `${theme.style({ c: t.ui.accent, bold: true })}${n.padEnd(12)}${ansiMod.reset()}`;
        return `${mark} ${name12} ${swatch}  ${highlight(sample, shell)}   ${ansiMod.fg(t.ui.muted)}${t.description}${ansiMod.reset()}`;
      });
      out(shell, io, `${line}\n`);
    }
    out(shell, io, `\n${ansiMod.fg(theme.current().ui.muted)}theme <name> switches and remembers it${ansiMod.reset()}\n`);
    return 0;
  }

  if (!theme.THEMES[name]) {
    const { closest } = require('./suggest');
    const guess = closest(name, theme.names());
    err(shell, io, `theme: no theme called ${name}${guess ? ` — did you mean ${guess}?` : ''} (theme lists them)\n`);
    return 1;
  }
  theme.setTheme(name);
  try { theme.saveTheme(name); } catch { /* can't persist; still switched */ }
  const { logoLines } = require('./banner');
  const logo = logoLines();
  out(shell, io, `\n  ${logo[0]}\n  ${logo[1]}\n\n  ${theme.fg('ok')}✓${ansiMod.reset()} theme ${theme.style({ c: theme.current().ui.accent, bold: true })}${name}${ansiMod.reset()} — ${theme.current().description}\n\n`);
  return 0;
};

// A modern ls at the terminal; the real one everywhere else. `command ls`
// always reaches the system ls.
BUILTINS.ls = (args, io, shell) => {
  const atTerminal = shell.interactive && io.stdout.kind === 'term' && process.stdout.isTTY && !shell.output;
  if (atTerminal) {
    const rendered = require('./ls').render(args, shell.cwd, process.stdout.columns || 80);
    if (rendered) {
      if (rendered.lines.length) out(shell, io, `${rendered.lines.join('\n')}\n`);
      return rendered.status;
    }
  }
  return shell.runExternal(['ls', ...args], io, shell.env);
};

BUILTINS.pwd = (args, io, shell) => {
  let dir = shell.cwd;
  if (args.includes('-P') || shell.options.has('chaselinks')) { try { dir = fs.realpathSync(dir); } catch { /* keep logical */ } }
  out(shell, io, `${dir}\n`);
  return 0;
};

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
  if (!args.length || (args.length === 1 && args[0] === '-p')) {
    for (const [name, entry] of [...shell.vars].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (entry.exported) out(shell, io, `export ${name}=${JSON.stringify(String(entry.value))}\n`);
    }
    return 0;
  }
  if (args[0] === '-n') {
    for (const a of args.slice(1)) { const e = shell.findEntry(a); if (e) e.exported = false; delete shell.env[a]; }
    return 0;
  }
  return declareLike(args, io, shell, { local: false, preset: 'x' });
};

BUILTINS.unset = (args, io, shell) => {
  let funcs = false;
  const names = [];
  for (const a of args) {
    if (a === '-f') funcs = true;
    else if (a === '-v' || a === '--') { /* variables are the default */ } else names.push(a);
  }
  let status = 0;
  for (const a of names) {
    if (funcs) { shell.funcs.delete(a); continue; }
    const el = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(a);
    try {
      if (el) {
        const entry = shell.findEntry(el[1]);
        if (entry && entry.value instanceof Map) { const m = new Map(entry.value); m.delete(el[2]); shell.setVar(el[1], m); } else if (entry && Array.isArray(entry.value)) {
          const arr = entry.value.slice();
          const n = Number(el[2]);
          if (n >= 1 && n <= arr.length) arr[n - 1] = '';
          shell.setVar(el[1], arr);
        }
      } else shell.unsetVar(a);
    } catch (e) { err(shell, io, `unset: ${e.message}\n`); status = 1; }
  }
  return status;
};

BUILTINS.unfunction = (args, io, shell) => {
  for (const a of args) shell.funcs.delete(a);
  return 0;
};

// typeset / declare / local / readonly / integer / float / export share
// this. Flags: -a array, -A associative, -i integer, -F/-E float, -r
// readonly, -x export, -l/-u lower/upper case, -g global, -f functions,
// -p print. Inside a function they declare locals unless -g.
function declareLike(args, io, shell, { local = true, preset = '' } = {}) {
  const flags = new Set(preset);
  const unflags = new Set();
  const items = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') { items.push(a); continue; }
    if (a === '--') { i++; break; }
    if (/^-[a-zA-Z]+$/.test(a) && !items.length) { for (const f of a.slice(1)) flags.add(f); continue; }
    if (/^\+[a-zA-Z]+$/.test(a) && !items.length) { for (const f of a.slice(1)) unflags.add(f); continue; }
    items.push(a);
  }
  items.push(...args.slice(i));

  if (flags.has('f')) {
    if (!items.length) { for (const n of [...shell.funcs.keys()].sort()) out(shell, io, `${n} () { … }\n`); return 0; }
    return items.every((n) => shell.funcs.has(n)) ? 0 : 1;
  }

  const describe = (name, entry) => {
    const v = entry.value;
    let opts = '';
    if (v instanceof Map) opts += ' -A';
    else if (Array.isArray(v)) opts += ' -a';
    if (entry.integer) opts += ' -i';
    if (entry.readonly) opts += ' -r';
    if (entry.exported) opts += ' -x';
    const q = (x) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(x) ? x : `'${String(x).replace(/'/g, "'\\''")}'`);
    const body = v instanceof Map ? `( ${[...v].map(([k, x]) => `[${q(k)}]=${q(x)}`).join(' ')} )`
      : Array.isArray(v) ? `( ${v.map(q).join(' ')} )` : q(v);
    return `typeset${opts} ${name}=${body}\n`;
  };

  if (!items.length) {
    const seen = new Set();
    for (let k = shell.scopes.length - 1; k >= 0; k--) {
      for (const [name, entry] of [...shell.scopes[k]].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (flags.has('x') && !entry.exported) continue;
        if (flags.has('r') && !entry.readonly) continue;
        out(shell, io, describe(name, entry));
      }
    }
    return 0;
  }

  const inFunction = shell.scopes.length > 1;
  const scope = local && inFunction && !flags.has('g') ? shell.scopes[shell.scopes.length - 1] : null;
  let status = 0;
  for (const item of items) {
    let name;
    let value;
    let hasValue = false;
    let append = false;
    if (typeof item === 'object') {
      name = item.name;
      value = item.values;
      hasValue = true;
      append = item.append;
    } else {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)(?:=([\s\S]*))?$/.exec(item);
      if (!m) { err(shell, io, `typeset: not an identifier: ${item}\n`); status = 1; continue; }
      name = m[1];
      append = m[2] === '+';
      if (m[3] !== undefined) { value = m[3]; hasValue = true; }
    }
    if (flags.has('p') && !hasValue) {
      const entry = shell.findEntry(name);
      if (entry) out(shell, io, describe(name, entry)); else { err(shell, io, `typeset: no such variable: ${name}\n`); status = 1; }
      continue;
    }

    let entry = scope ? scope.get(name) : shell.findEntry(name);
    if (!entry) {
      entry = { value: flags.has('A') ? new Map() : flags.has('a') ? [] : '', exported: Object.prototype.hasOwnProperty.call(shell.env, name) && !scope };
      if (!hasValue && !flags.has('A') && !flags.has('a') && !scope) {
        const existing = shell.env[name];
        if (existing !== undefined) entry.value = existing;
      }
      if (scope) scope.set(name, entry); else shell.vars.set(name, entry);
    } else if (entry.readonly && (hasValue || flags.size)) {
      err(shell, io, `typeset: read-only variable: ${name}\n`);
      status = 1;
      continue;
    }
    if (flags.has('A') && !(entry.value instanceof Map)) entry.value = new Map();
    if (flags.has('a') && !Array.isArray(entry.value)) entry.value = entry.value === '' ? [] : [entry.value];
    for (const [f, key] of [['i', 'integer'], ['F', 'float'], ['E', 'float'], ['l', 'lower'], ['u', 'upper']]) {
      if (flags.has(f)) entry[key] = true;
      if (unflags.has(f)) entry[key] = false;
    }
    if (flags.has('x')) entry.exported = true;
    if (unflags.has('x')) { entry.exported = false; delete shell.env[name]; }

    try {
      if (hasValue) {
        if (Array.isArray(value)) {
          if (entry.value instanceof Map) {
            const m = append ? new Map(entry.value) : new Map();
            for (let k = 0; k < value.length; k += 2) m.set(value[k], value[k + 1] ?? '');
            entry.value = m;
          } else entry.value = append && Array.isArray(entry.value) ? entry.value.concat(value) : value;
        } else if (append && (entry.integer || entry.float)) {
          entry.value = shell.coerce(name, entry, `(${entry.value || 0})+(${value || 0})`);
        } else entry.value = shell.coerce(name, entry, append ? `${entry.value}${value}` : value);
      } else if (entry.integer && typeof entry.value === 'string') {
        entry.value = shell.coerce(name, entry, entry.value || '0');
      } else if ((entry.lower || entry.upper) && typeof entry.value === 'string') {
        entry.value = shell.coerce(name, entry, entry.value);
      }
    } catch (e) { err(shell, io, `typeset: ${e.message}\n`); status = 1; continue; }
    if (flags.has('r')) entry.readonly = true;
    if (entry.exported) shell.env[name] = Array.isArray(entry.value) ? entry.value.join(' ') : entry.value instanceof Map ? [...entry.value.values()].join(' ') : entry.value;
  }
  return status;
}

BUILTINS.local = (args, io, shell) => declareLike(args, io, shell);
BUILTINS.typeset = (args, io, shell) => declareLike(args, io, shell);
BUILTINS.declare = (args, io, shell) => declareLike(args, io, shell);
BUILTINS.readonly = (args, io, shell) => declareLike(args, io, shell, { local: false, preset: 'r' });
BUILTINS.integer = (args, io, shell) => declareLike(args, io, shell, { preset: 'i' });
BUILTINS.float = (args, io, shell) => declareLike(args, io, shell, { preset: 'F' });

// alias name=value; -g global (expands anywhere on the line); -s suffix
// (alias -s txt=vim makes `notes.txt` open in vim); -L prints as commands.
BUILTINS.alias = (args, io, shell) => {
  let kind = 'aliases';
  let asCmd = false;
  const items = [];
  for (const a of args) {
    if (/^-[gsLrm]+$/.test(a)) {
      if (a.includes('g')) kind = 'galiases';
      if (a.includes('s')) kind = 'saliases';
      if (a.includes('L')) asCmd = true;
    } else items.push(a);
  }
  const map = shell[kind];
  const flag = kind === 'galiases' ? ' -g' : kind === 'saliases' ? ' -s' : '';
  const q = (v) => `'${v.replace(/'/g, "'\\''")}'`;
  const show = (n, v) => (asCmd ? `alias${flag} ${n}=${q(v)}\n` : `${n}=${/^[\w@%+=:,./-]+$/.test(v) ? v : q(v)}\n`);
  if (!items.length) {
    for (const [name, value] of [...map].sort()) out(shell, io, show(name, value));
    return 0;
  }
  let status = 0;
  for (const a of items) {
    const eq = a.indexOf('=');
    if (eq === -1) {
      if (map.has(a)) out(shell, io, show(a, map.get(a)));
      else { err(shell, io, `alias: no such alias: ${a}\n`); status = 1; }
    } else {
      map.set(a.slice(0, eq), a.slice(eq + 1));
    }
  }
  return status;
};

BUILTINS.unalias = (args, io, shell) => {
  let kind = 'aliases';
  let status = 0;
  for (const a of args) {
    if (a === '-g') { kind = 'galiases'; continue; }
    if (a === '-s') { kind = 'saliases'; continue; }
    if (a === '-a') { shell[kind].clear(); continue; }
    if (!shell[kind].delete(a)) { err(shell, io, `unalias: no such hash table element: ${a}\n`); status = 1; }
  }
  return status;
};

// abbr gco='git checkout' — typed at the start of a command, it expands in
// place when you press space or Enter, so history shows what really ran.
BUILTINS.abbr = (args, io, shell) => {
  if (!args.length || args[0] === '-l' || args[0] === '--list') {
    for (const [n, v] of [...shell.abbrs].sort()) out(shell, io, args.length ? `${n}\n` : `abbr ${n}='${v.replace(/'/g, "'\\''")}'\n`);
    return 0;
  }
  if (args[0] === '-e' || args[0] === '--erase') {
    let status = 0;
    for (const n of args.slice(1)) if (!shell.abbrs.delete(n)) { err(shell, io, `abbr: no abbreviation ${n}\n`); status = 1; }
    return status;
  }
  let status = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    if (eq > 0) shell.abbrs.set(a.slice(0, eq), a.slice(eq + 1));
    else if (args[i + 1] !== undefined) { shell.abbrs.set(a, args.slice(i + 1).join(' ')); break; } else if (shell.abbrs.has(a)) out(shell, io, `${shell.abbrs.get(a)}\n`);
    else { err(shell, io, `abbr: no abbreviation ${a}\n`); status = 1; }
  }
  return status;
};

// --- the palette, explain, dash, snippets and bookmarks -----------------------

// ai: mx, the small language model trained for maxshell (models/mx.bin),
// run on this Mac with no dependencies.
BUILTINS.ai = (args, io, shell) => require('./ai').runAi(args, io, shell);

// aig: Gemma 4 (E4B, or E2B with --e2b), Google's open model, run on this Mac by src/gemma.py.
BUILTINS.aig = (args, io, shell) => require('./gemma').runAig(args, io, shell);

// bot: a chat "AI" that is really a list of if/else rules (no AI, no network).
BUILTINS.bot = (args, io, shell) => require('./bot').runBot(args, io, shell);

// 6-7: brainrot mode for this session (6-7 again, or 6-7 off, to stop).
BUILTINS['6-7'] = (args, io, shell) => {
  out(shell, io, require('./brainrot').toggle(shell, args[0]));
  return 0;
};

// cleanup: quit what isn't needed; -r / -c then offer the biggest users.
BUILTINS.cleanup = (args, io, shell) => require('./cleanup').runCleanup(args, io, shell);

BUILTINS.dash = (args, io, shell) => require('./dash').runDash(args, io, shell);

// palette: pick anything and run it (Ctrl-P at the prompt does the same and
// puts "insert" items on the line to edit).
BUILTINS.palette = (args, io, shell) => {
  const { requireTty } = require('./tui');
  if (!requireTty('palette', io, shell)) return 1;
  const item = require('./picker').pick(require('./palette').paletteItems(shell), { title: 'maxshell — do anything', hint: 'run' });
  if (!item) return 0;
  if (item.insert) { shell.prefill = item.value; return 0; }
  return shell.runSource(item.value, io);
};

// explain 'command line' — what it will do, piece by piece (Alt-H at the prompt).
BUILTINS.explain = (args, io, shell) => {
  if (!args.length) { err(shell, io, "explain: give it a command line, e.g. explain 'tar -czf x.tgz src'\n"); return 1; }
  const cols = process.stdout.columns || 80;
  out(shell, io, `${require('./explain').explain(args.join(' '), shell, cols).join('\n')}\n`);
  return 0;
};

// snip                 pick a saved snippet (it goes on the prompt to edit)
// snip add NAME CMD…   save one     snip save NAME   save the last command
// snip rm NAME   snip mv OLD NEW   snip -l
BUILTINS.snip = (args, io, shell) => {
  const { Store, snippetsFile } = require('./snippets');
  const store = new Store(snippetsFile());
  const [sub, ...rest] = args;
  if (sub === '-l' || sub === 'list' || (!sub && !process.stdout.isTTY)) {
    const w = Math.max(4, ...store.entries().map(([n]) => n.length));
    for (const [n, v] of store.entries()) out(shell, io, `${n.padEnd(w)}  ${v}\n`);
    return 0;
  }
  if (!sub) {
    if (!store.entries().length) { out(shell, io, 'no snippets yet — Alt-S at the prompt saves the line you are typing\n'); return 0; }
    const item = require('./picker').pick(store.entries().map(([n, v]) => ({ label: n, desc: v, icon: '✂️', value: v })), { title: 'snippets', hint: 'put on the prompt' });
    if (item) shell.prefill = item.value;
    return 0;
  }
  if (sub === 'add' && rest.length >= 2) { store.set(rest[0], rest.slice(1).join(' ')); return 0; }
  if (sub === 'save' && rest.length === 1) {
    const last = [...shell.history].reverse().find((c) => !/^\s*snip\b/.test(c));
    if (!last) { err(shell, io, 'snip: no command to save yet\n'); return 1; }
    store.set(rest[0], last);
    out(shell, io, `saved ${rest[0]}: ${last}\n`);
    return 0;
  }
  if (sub === 'rm' && rest.length) {
    let status = 0;
    for (const n of rest) if (!store.delete(n)) { err(shell, io, `snip: no snippet ${n}\n`); status = 1; }
    return status;
  }
  if (sub === 'mv' && rest.length === 2) {
    if (!store.rename(rest[0], rest[1])) { err(shell, io, `snip: no snippet ${rest[0]}\n`); return 1; }
    return 0;
  }
  if (store.get(sub) !== undefined && !rest.length) { shell.prefill = store.get(sub); return 0; }
  err(shell, io, 'usage: snip [NAME] | snip add NAME CMD… | snip save NAME | snip rm NAME | snip mv OLD NEW | snip -l\n');
  return 1;
};

// mark [NAME] bookmarks this folder (named after it by default);
// mark -d NAME removes one; marks lists them; go [NAME] goes there.
BUILTINS.mark = (args, io, shell) => {
  const { Store, marksFile } = require('./snippets');
  const store = new Store(marksFile());
  if (args[0] === '-d') {
    let status = 0;
    for (const n of args.slice(1)) if (!store.delete(n)) { err(shell, io, `mark: no bookmark ${n}\n`); status = 1; }
    return status;
  }
  if (args[0] === '-l') return BUILTINS.marks([], io, shell);
  const name = args[0] || path.basename(shell.cwd) || 'root';
  store.set(name, shell.cwd);
  out(shell, io, `🔖 ${name} → ${shell.cwd}\n`);
  return 0;
};

BUILTINS.marks = (args, io, shell) => {
  const { Store, marksFile } = require('./snippets');
  const entries = new Store(marksFile()).entries();
  const w = Math.max(4, ...entries.map(([n]) => n.length));
  for (const [n, d] of entries) out(shell, io, `${n.padEnd(w)}  ${d}\n`);
  return 0;
};

BUILTINS.go = (args, io, shell) => {
  const { Store, marksFile } = require('./snippets');
  const store = new Store(marksFile());
  let dir;
  if (args[0]) {
    dir = store.get(args[0]);
    if (!dir) {
      const hit = store.entries().find(([n]) => n.startsWith(args[0]));
      if (hit) [, dir] = hit;
    }
    if (!dir) { err(shell, io, `go: no bookmark ${args[0]} (mark saves one)\n`); return 1; }
  } else {
    if (!store.entries().length) { out(shell, io, 'no bookmarks yet — mark saves this folder\n'); return 0; }
    if (!process.stdout.isTTY) return BUILTINS.marks([], io, shell);
    const item = require('./picker').pick(store.entries().map(([n, d]) => ({ label: n, desc: d, icon: '🔖', value: d })), { title: 'bookmarks', hint: 'go there' });
    if (!item) return 0;
    dir = item.value;
  }
  try { shell.setCwd(dir); } catch (e) { err(shell, io, `go: ${dir}: ${e.code === 'ENOENT' ? 'no longer exists' : e.message}\n`); return 1; }
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
  const { evalArith } = require('./arith');
  throw new ReturnSignal(args.length ? Math.trunc(evalArith(args[0], shell)) & 0xff : shell.status);
};

function loopControl(Signal, word) {
  return (args, io, shell) => {
    if (!shell.loopDepth) { err(shell, io, `${word}: not in while, until, select, or repeat loop\n`); return 1; }
    const n = args.length ? Number(args[0]) : 1;
    if (!Number.isInteger(n) || n < 1) { err(shell, io, `${word}: argument is not positive: ${args[0]}\n`); return 1; }
    throw new Signal(Math.min(n, shell.loopDepth));
  };
}
BUILTINS.break = loopControl(BreakSignal, 'break');
BUILTINS.continue = loopControl(ContinueSignal, 'continue');

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

BUILTINS.eval = (args, io, shell) => (args.length ? shell.runSource(args.join(' '), io) : 0);

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
  const savedDepth = shell.funcDepth;
  try {
    return shell.runSource(src, io);
  } catch (e) {
    // return in a sourced file stops the file.
    if (e instanceof ReturnSignal && shell.funcDepth === savedDepth) return e.status;
    throw e;
  } finally { shell.positional = saved; }
};
BUILTINS['.'] = BUILTINS.source;

BUILTINS.read = (args, io, shell) => {
  let raw = false;
  let prompt = null;
  let arrayName = null;
  let delim = '\n';
  let nchars = null;
  let silent = false;
  let quiet = false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i].length > 1) {
    const flag = args[i];
    if (flag === '--') { i++; break; }
    if (flag === '-p') { prompt = args[i + 1] ?? ''; i += 2; continue; }
    if (flag === '-A' || flag === '-a') { arrayName = args[i + 1]; i += 2; continue; }
    if (flag === '-d') { delim = (args[i + 1] ?? '\n')[0] ?? '\0'; i += 2; continue; }
    if (flag === '-k' || flag === '-n') { nchars = Number(args[i + 1]) || 1; i += 2; continue; }
    if (flag === '-t') { i += /^\d/.test(args[i + 1] || '') ? 2 : 1; continue; }
    if (/^-[rsqeE]+$/.test(flag)) {
      if (flag.includes('r')) raw = true;
      if (flag.includes('s')) silent = true;
      if (flag.includes('q')) quiet = true;
      i++;
      continue;
    }
    if (flag.startsWith('-p')) { prompt = flag.slice(2); i++; continue; }
    break;
  }
  // zsh: read 'name?prompt' shows the prompt.
  if (args[i] && args[i].includes('?')) {
    const q = args[i].indexOf('?');
    prompt = args[i].slice(q + 1);
    args = [...args.slice(0, i), args[i].slice(0, q), ...args.slice(i + 1)];
  }
  if (prompt !== null) err(shell, io, prompt);

  let line;
  if (nchars !== null || delim !== '\n' || silent || quiet) line = readChars(shell, io.stdin, { nchars: quiet ? 1 : nchars, delim, silent });
  else line = shell.readLine(io.stdin);
  if (quiet) {
    const yes = /^[yY]$/.test(line || '');
    shell.setVar(args[i] || 'REPLY', yes ? 'y' : 'n');
    return yes ? 0 : 1;
  }
  if (line === null) return 1;
  const text = raw ? line : line.replace(/\\(.)/g, '$1');

  const ifs = shell.getVar('IFS') ?? ' \t\n';
  const fieldsOf = (t) => {
    if (!ifs) return [t];
    const re = new RegExp(`[${ifs.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]+`);
    return t.split(re).filter((f, idx, arr) => !(f === '' && (idx === 0 || idx === arr.length - 1)));
  };
  if (arrayName) { shell.setVar(arrayName, fieldsOf(text)); return 0; }

  const names = args.slice(i);
  if (!names.length) { shell.setVar('REPLY', text); return 0; }

  const fields = fieldsOf(text);
  names.forEach((name, idx) => {
    if (idx === names.length - 1) {
      // The last name takes the rest of the line, as typed.
      let rest = text;
      for (let k = 0; k < idx && k < fields.length; k++) rest = rest.slice(rest.indexOf(fields[k]) + fields[k].length);
      const trim = ifs.replace(/[^ \t\n]/g, '');
      rest = idx ? rest.replace(new RegExp(`^[${trim}]*[${ifs.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]?[${trim}]*`), '') : rest.replace(new RegExp(`^[${trim}]+`), '');
      shell.setVar(name, rest.replace(new RegExp(`[${trim}]+$`), '') );
    } else shell.setVar(name, fields[idx] ?? '');
  });
  return 0;
};

// Reads up to a delimiter or a number of characters; -s turns echo off.
function readChars(shell, desc, { nchars, delim, silent }) {
  if (desc.kind === 'string') {
    const rest = desc.data.slice(desc.pos);
    let end = nchars !== null ? Math.min(nchars, rest.length) : rest.indexOf(delim);
    if (end === -1) end = rest.length;
    if (!rest.length) return null;
    desc.pos += end + (nchars === null && end < rest.length ? 1 : 0);
    return rest.slice(0, end);
  }
  const fd = desc.kind === 'fd' ? desc.fd : 0;
  const tty = fd === 0 && process.stdin.isTTY;
  let wasRaw = false;
  if (tty && (silent || nchars !== null)) {
    wasRaw = process.stdin.isRaw;
    try { process.stdin.setRawMode(true); } catch { /* not a tty */ }
  }
  const buf = Buffer.alloc(4);
  let line = '';
  try {
    for (;;) {
      let n = 0;
      n = require('./interpreter').readRetrying(fd, buf, 1);
      if (!n) return line === '' ? null : line;
      const c = buf.toString('utf8', 0, n);
      if (tty && c === '\x03') { process.stdout.write('\n'); return null; }
      if (nchars === null && (c === delim || (tty && c === '\r' && delim === '\n'))) break;
      line += c;
      if (nchars !== null && [...line].length >= nchars) break;
    }
  } finally {
    if (tty && (silent || nchars !== null)) {
      try { process.stdin.setRawMode(wasRaw); } catch { /* not a tty */ }
      if (silent) process.stdout.write('\n');
    }
  }
  return line;
}

// Option names as zsh spells them: case and underscores don't matter, and
// a leading "no" turns one off. The one-letter forms map onto the same set.
const OPTION_LETTERS = { errexit: 'e', nounset: 'u', xtrace: 'x', verbose: 'v', noglob: 'noglob', allexport: 'allexport' };
const LETTER_OPTIONS = { e: 'e', u: 'u', x: 'x', v: 'v', f: 'noglob', a: 'allexport', C: 'noclobber' };
const KNOWN_OPTIONS = new Set(['e', 'u', 'x', 'v', 'pipefail', 'noglob', 'allexport', 'noclobber', 'autocd', 'nullglob',
  'globdots', 'nomatch', 'shwordsplit', 'globsubst', 'extendedglob', 'ignorebraces', 'chaselinks', 'autopushd',
  'pushdignoredups', 'pushdsilent', 'ksharrays', 'promptsubst', 'interactivecomments', 'histignorespace', 'correct',
  'caseglob', 'markdirs', 'localoptions', 'nonotify', 'notify', 'monitor', 'banghist', 'sharehistory', 'appendhistory',
  'incappendhistory', 'histignorealldups', 'histignoredups', 'histreduceblanks', 'extendedhistory', 'autolist',
  'automenu', 'completeinword', 'alwaystoend', 'autoparamslash', 'listpacked', 'menucomplete', 'nobeep', 'beep']);

function setOption(shell, name, on) {
  let n = String(name).toLowerCase().replace(/_/g, '');
  if (OPTION_LETTERS[n]) n = OPTION_LETTERS[n];
  else if (!KNOWN_OPTIONS.has(n) && n.startsWith('no') && KNOWN_OPTIONS.has(n.slice(2))) { n = n.slice(2); on = !on; } else if (!KNOWN_OPTIONS.has(n) && n.startsWith('no') && OPTION_LETTERS[n.slice(2)]) { n = OPTION_LETTERS[n.slice(2)]; on = !on; }
  if (!KNOWN_OPTIONS.has(n)) return false;
  if (on) shell.options.add(n); else shell.options.delete(n);
  return true;
}

BUILTINS.set = (args, io, shell) => {
  if (!args.length) {
    for (const [name, entry] of [...shell.vars].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const v = entry.value;
      out(shell, io, `${name}=${v instanceof Map ? `(${[...v.values()].join(' ')})` : Array.isArray(v) ? `(${v.join(' ')})` : v}\n`);
    }
    return 0;
  }
  let i = 0;
  let status = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (a === '-') { i++; break; }
    if (a === '-o' || a === '+o') {
      const name = args[++i];
      if (!name) {
        for (const o of [...KNOWN_OPTIONS].sort()) out(shell, io, `${o.padEnd(22)}${shell.options.has(o) ? 'on' : 'off'}\n`);
        continue;
      }
      if (!setOption(shell, name, a === '-o')) { err(shell, io, `set: no such option: ${name}\n`); status = 1; }
      continue;
    }
    if (a === '-A' || a === '+A') {
      const name = args[i + 1];
      if (name) shell.setVar(name, args.slice(i + 2));
      return 0;
    }
    if (/^[-+][a-zA-Z]+$/.test(a)) {
      for (const f of a.slice(1)) {
        const n = LETTER_OPTIONS[f];
        if (!n) { err(shell, io, `set: bad option: ${a[0]}${f}\n`); status = 1; continue; }
        if (a[0] === '-') shell.options.add(n); else shell.options.delete(n);
      }
      continue;
    }
    break;
  }
  if (i < args.length || args.includes('--') || args.includes('-')) shell.positional = args.slice(i);
  return status;
};

BUILTINS.setopt = (args, io, shell) => {
  if (!args.length) {
    for (const o of [...shell.options].map((x) => ({ e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose' }[x] || x)).sort()) out(shell, io, `${o}\n`);
    return 0;
  }
  let status = 0;
  for (const a of args) if (!setOption(shell, a, true)) { err(shell, io, `setopt: no such option: ${a}\n`); status = 1; }
  return status;
};

BUILTINS.unsetopt = (args, io, shell) => {
  let status = 0;
  for (const a of args) if (!setOption(shell, a, false)) { err(shell, io, `unsetopt: no such option: ${a}\n`); status = 1; }
  return status;
};

// maxshell always behaves like zsh; emulate is accepted so scripts that
// start with `emulate -L zsh` run.
BUILTINS.emulate = () => 0;

// trap 'code' SIG…   trap - SIG   trap '' SIG   trap (lists them)
const SIGNAL_NAMES = ['EXIT', 'ERR', 'ZERR', 'DEBUG', 'HUP', 'INT', 'QUIT', 'TERM', 'USR1', 'USR2', 'WINCH', 'ALRM', 'PIPE', 'CHLD', 'CONT', 'TSTP'];
function sigName(s) {
  const up = String(s).toUpperCase().replace(/^SIG/, '');
  if (up === '0') return 'EXIT';
  if (up === 'ZERR') return 'ERR';
  if (/^\d+$/.test(up)) {
    const found = Object.entries(os.constants.signals).find(([, n]) => n === Number(up));
    return found ? found[0].replace(/^SIG/, '') : null;
  }
  return SIGNAL_NAMES.includes(up) || os.constants.signals[`SIG${up}`] ? up : null;
}

BUILTINS.trap = (args, io, shell) => {
  if (!args.length || (args.length === 1 && args[0] === '-p')) {
    for (const [sig, code] of shell.traps) out(shell, io, `trap -- '${code.replace(/'/g, "'\\''")}' ${sig}\n`);
    return 0;
  }
  if (args[0] === '-l') { out(shell, io, `${SIGNAL_NAMES.join(' ')}\n`); return 0; }
  let code = args[0];
  let sigs = args.slice(1);
  if (args[0] === '--') { code = args[1]; sigs = args.slice(2); }
  if (!sigs.length && sigName(code)) { sigs = [code]; code = '-'; }
  let status = 0;
  for (const s of sigs) {
    const name = sigName(s);
    if (!name) { err(shell, io, `trap: undefined signal: ${s}\n`); status = 1; continue; }
    if (code === '-') shell.traps.delete(name);
    else shell.traps.set(name, code);
    if (shell.onTrapChange) shell.onTrapChange(name);
  }
  return status;
};

// getopts optstring name [args…] — one option per call, via OPTIND/OPTARG.
BUILTINS.getopts = (args, io, shell) => {
  if (args.length < 2) { err(shell, io, 'getopts: not enough arguments\n'); return 2; }
  let [spec, name, ...list] = args;
  if (!list.length) list = shell.positional;
  const silent = spec.startsWith(':');
  if (silent) spec = spec.slice(1);
  let ind = Number(shell.getVar('OPTIND') || 1);
  if (!Number.isInteger(ind) || ind < 1) ind = 1;
  let pos = shell.getoptsPos && shell.getoptsPos.ind === ind ? shell.getoptsPos.pos : 1;
  const word = list[ind - 1];
  if (word === undefined || word === '--' || !/^[-+]./.test(word)) {
    if (word === '--') shell.setVar('OPTIND', String(ind + 1));
    shell.setVar(name, '?');
    shell.getoptsPos = null;
    return 1;
  }
  const opt = word[pos];
  const next = () => {
    if (pos + 1 < word.length) { shell.getoptsPos = { ind, pos: pos + 1 }; } else { shell.getoptsPos = null; ind++; }
    shell.setVar('OPTIND', String(ind));
  };
  const at = spec.indexOf(opt);
  if (at === -1 || opt === ':') {
    shell.setVar(name, '?');
    if (silent) shell.setVar('OPTARG', opt); else { shell.unsetVar('OPTARG'); err(shell, io, `${shell.scriptName}: bad option: -${opt}\n`); }
    next();
    return 0;
  }
  if (spec[at + 1] === ':') {
    let arg;
    if (pos + 1 < word.length) { arg = word.slice(pos + 1); ind++; } else { arg = list[ind]; ind += 2; }
    shell.getoptsPos = null;
    shell.setVar('OPTIND', String(ind));
    if (arg === undefined) {
      if (silent) { shell.setVar(name, ':'); shell.setVar('OPTARG', opt); } else { shell.setVar(name, '?'); err(shell, io, `${shell.scriptName}: argument expected after -${opt} option\n`); }
      return 0;
    }
    shell.setVar(name, word[0] === '+' ? `+${opt}` : opt);
    shell.setVar('OPTARG', arg);
    return 0;
  }
  shell.setVar(name, word[0] === '+' ? `+${opt}` : opt);
  shell.unsetVar('OPTARG');
  next();
  return 0;
};

// command name args: skips functions and aliases. The system program wins
// (so `command ls` is the real ls), falling back to a builtin.
// command -v / -V say what a name is.
BUILTINS.command = (args, io, shell) => {
  let i = 0;
  let mode = null;
  while (i < args.length && /^-[pvV]+$/.test(args[i])) {
    if (args[i].includes('v')) mode = 'v';
    if (args[i].includes('V')) mode = 'V';
    i++;
  }
  const rest = args.slice(i);
  if (!rest.length) return 0;
  if (mode) {
    let status = 0;
    for (const n of rest) {
      const d = mode === 'v' ? whenceOne(n, shell, { short: true })[0] : whenceOne(n, shell, { verbose: true })[0];
      if (d) out(shell, io, `${d}\n`); else { if (mode === 'V') err(shell, io, `${n} not found\n`); status = 1; }
    }
    return status;
  }
  if (!findInPath(rest[0], shell) && BUILTINS[rest[0]]) return BUILTINS[rest[0]](rest.slice(1), io, shell) ?? 0;
  return shell.runExternal(rest, io, shell.env);
};

// builtin name args: runs the builtin even if a function has the name.
BUILTINS.builtin = (args, io, shell) => {
  if (!args.length) return 0;
  if (!BUILTINS[args[0]]) { err(shell, io, `builtin: no such builtin: ${args[0]}\n`); return 1; }
  return BUILTINS[args[0]](args.slice(1), io, shell) ?? 0;
};

// --- job control --------------------------------------------------------------

BUILTINS.jobs = (args, io, shell) => {
  const long = args.includes('-l');
  const pids = args.includes('-p');
  for (const job of shell.jobs.slice()) {
    job.poll();
    if (pids) out(shell, io, `${job.pgid || job.helperPid}\n`);
    else out(shell, io, `${shell.jobLine(job, { long })}\n`);
    if (job.finished) shell.removeJob(job);
  }
  return 0;
};

function jobArg(args, shell, io, name) {
  const job = shell.findJob(args[0]);
  if (!job) {
    err(shell, io, args[0] ? `${name}: no such job: ${args[0]}\n` : `${name}: no current job\n`);
    return null;
  }
  return job;
}

BUILTINS.fg = (args, io, shell) => {
  const job = jobArg(args, shell, io, 'fg');
  if (!job) return 1;
  job.poll();
  if (job.finished) { out(shell, io, `${shell.jobLine(job)}\n`); shell.removeJob(job); return job.code ?? 0; }
  return shell.foregroundJob(job, io);
};

BUILTINS.bg = (args, io, shell) => {
  const job = jobArg(args, shell, io, 'bg');
  if (!job) return 1;
  job.poll();
  if (job.state === 'running') { err(shell, io, `bg: job already in background\n`); return 1; }
  job.background();
  job.notified = false;
  out(shell, io, `[${job.id}]  - continued  ${job.cmd}\n`);
  return 0;
};

BUILTINS.disown = (args, io, shell) => {
  const job = jobArg(args, shell, io, 'disown');
  if (!job) return 1;
  shell.jobs = shell.jobs.filter((j) => j !== job);
  if (shell.currentJob === job) shell.currentJob = shell.jobs[shell.jobs.length - 1] || null;
  return 0;
};

// wait [%job|pid…] — for background jobs to finish.
BUILTINS.wait = (args, io, shell) => {
  const { sleep } = require('./jobs');
  const targets = args.length ? args.map((a) => shell.findJob(a.startsWith('%') ? a : a)).filter(Boolean) : shell.jobs.slice();
  let status = 0;
  for (const job of targets) {
    // A job we just signalled may take a moment to act on it.
    for (let spins = 0; !job.finished; spins++) {
      job.poll();
      if (job.finished) break;
      if (job.state === 'stopped' && spins > 20) break;
      sleep(10);
    }
    status = job.code ?? 0;
    if (job.finished) shell.removeJob(job);
  }
  return status;
};

// kill with job specs: kill %1, kill -9 %vim, kill -s TERM 1234, kill -l
BUILTINS.kill = (args, io, shell) => {
  let sig = 'SIGTERM';
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l' || a === '-L') {
      out(shell, io, `${Object.keys(os.constants.signals).map((n) => n.replace(/^SIG/, '')).join(' ')}\n`);
      return 0;
    }
    if (a === '-s' || a === '-n') { sig = args[++i]; continue; }
    if (/^-\w+$/.test(a) && !targets.length) { sig = a.slice(1); continue; }
    targets.push(a);
  }
  if (/^\d+$/.test(String(sig))) {
    const found = Object.entries(os.constants.signals).find(([, n]) => n === Number(sig));
    sig = found ? found[0] : sig;
  } else if (!String(sig).startsWith('SIG')) sig = `SIG${String(sig).toUpperCase()}`;
  if (!os.constants.signals[sig] && sig !== 'SIG0') { err(shell, io, `kill: unknown signal: ${sig}\n`); return 1; }
  if (!targets.length) { err(shell, io, 'kill: not enough arguments\n'); return 1; }
  let status = 0;
  for (const t of targets) {
    try {
      if (t.startsWith('%')) {
        const job = shell.findJob(t);
        if (!job) { err(shell, io, `kill: no such job: ${t}\n`); status = 1; continue; }
        job.kill(sig);
      } else process.kill(Number(t), sig === 'SIG0' ? 0 : sig);
    } catch (e) {
      err(shell, io, `kill: kill ${t} failed: ${e.code === 'ESRCH' ? 'no such process' : e.code === 'EPERM' ? 'operation not permitted' : e.message}\n`);
      status = 1;
    }
  }
  return status;
};

// Every meaning of a name, most important first, in one of zsh's styles:
// short (whence), verbose (whence -v / type), csh (which / whence -c).
function whenceOne(name, shell, { verbose = false, csh = false, all = false, short = false, pathOnly = false } = {}) {
  const found = [];
  if (!pathOnly) {
    if (shell.aliases.has(name)) {
      const v = shell.aliases.get(name);
      found.push(verbose ? `${name} is an alias for ${v}` : csh ? `${name}: aliased to ${v}` : short ? `alias ${name}=${JSON.stringify(v)}` : v);
    }
    if (RESERVED.has(name)) found.push(verbose ? `${name} is a reserved word` : csh ? `${name}: shell reserved word` : name);
    if (shell.funcs.has(name)) found.push(verbose ? `${name} is a shell function` : csh ? `${name} () { … }` : name);
    if (BUILTINS[name]) found.push(verbose ? `${name} is a shell builtin` : csh ? `${name}: shell built-in command` : name);
  }
  const dirs = (shell.env.PATH || '').split(':').filter(Boolean);
  const paths = [];
  if (name.includes('/')) { const p = findInPath(name, shell); if (p) paths.push(p); } else {
    for (const d of dirs) {
      const p = path.join(d, name);
      try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); if (!paths.includes(p)) paths.push(p); } } catch { /* keep looking */ }
    }
  }
  for (const p of paths) found.push(verbose ? `${name} is ${p}` : p);
  return all ? found : found.slice(0, 1);
}

function whenceLike(args, io, shell, defaults) {
  const opts = { ...defaults };
  let i = 0;
  for (; i < args.length && /^-[vcapmsw]+$/.test(args[i]); i++) {
    if (args[i].includes('v')) opts.verbose = true;
    if (args[i].includes('c')) opts.csh = true;
    if (args[i].includes('a')) opts.all = true;
    if (args[i].includes('p')) opts.pathOnly = true;
  }
  let status = 0;
  for (const a of args.slice(i)) {
    const lines = whenceOne(a, shell, opts);
    if (lines.length) out(shell, io, `${lines.join('\n')}\n`);
    else {
      status = 1;
      if (opts.verbose) out(shell, io, `${a} not found\n`);
      else if (opts.csh) out(shell, io, `${a} not found\n`);
    }
  }
  return status;
}

BUILTINS.type = (args, io, shell) => whenceLike(args, io, shell, { verbose: true });
BUILTINS.whence = (args, io, shell) => whenceLike(args, io, shell, {});
BUILTINS.which = (args, io, shell) => whenceLike(args, io, shell, { csh: true });
BUILTINS.where = (args, io, shell) => whenceLike(args, io, shell, { csh: true, all: true });

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


module.exports = {
  BUILTINS,
  HELP_TEXT,
  testUnary,
  testBinary,
  unescapeString,
  formatPrintf,
  findInPath,
};
