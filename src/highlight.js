'use strict';

const fs = require('fs');

const ansi = require('./ansi');
const { BUILTINS } = require('./builtins');
const { RESERVED, REDIR_OPS } = require('./lexer');
const { findInPath } = require('./builtins');

const OPERATORS = [
  '<<<', '&>>', '<<-', '&&', '||', ';;', ';&', ';|', '>>', '<<', '>&', '<&', '&>', '|&',
  '|', '&', ';', '(', ')', '<', '>',
];

// What kind of thing is this word, in command position?
function classifyCommand(word, shell) {
  if (!word) return 'arg';
  if (RESERVED.has(word)) return 'reserved';
  if (shell.aliases && shell.aliases.has(word)) return 'alias';
  if (shell.funcs && shell.funcs.has(word)) return 'function';
  if (BUILTINS[word]) return 'builtin';
  // Anything still containing expansions or globs can't be resolved yet, so
  // don't flag it as unknown while the user is still typing.
  if (/[$*?`]/.test(word) || (word.startsWith('~') && word.length > 1 && !word.startsWith('~/'))) return 'command';

  const ext = /\.([^./]+)$/.exec(word);
  if (ext && shell.saliases && shell.saliases.has(ext[1])) return 'alias';

  // Keyed by folder and PATH too: `./run` or a folder name means something
  // else after a cd, and a new PATH finds different programs.
  if (!shell._cmdCache || shell._cmdCache.size > 2000) shell._cmdCache = new Map();
  const key = `${shell.cwd}\0${shell.env.PATH}\0${word}`;
  if (shell._cmdCache.has(key)) return shell._cmdCache.get(key);

  let kind = 'unknown';
  try {
    if (word.includes('/')) {
      kind = fs.existsSync(shell.resolve(word)) ? 'command' : 'unknown';
    } else {
      kind = findInPath(word, shell) ? 'command' : 'unknown';
    }
    // With AUTO_CD a folder name on its own is a fine thing to type.
    if (kind === 'unknown' && shell.options && shell.options.has('autocd')) {
      const home = shell.getVar('HOME') || require('os').homedir();
      if (fs.statSync(shell.resolve(word.replace(/^~(?=$|\/)/, home))).isDirectory()) kind = 'command';
    }
  } catch { /* stays unknown */ }

  shell._cmdCache.set(key, kind);
  return kind;
}

function palette() {
  const theme = require('./theme');
  const c = theme.current().shell;
  const st = theme.style;
  return {
    reserved: st(c.reserved),
    builtin: st(c.builtin),
    command: st(c.command),
    function: st(c.command),
    alias: st(c.alias),
    unknown: st(c.unknown),
    arg: '',
    string: st(c.string),
    variable: st(c.variable),
    operator: st(c.operator),
    comment: st(c.comment),
    assign: st(c.assign),
  };
}

// Paints one word, colouring quoted runs and expansions inside it.
function paintWord(raw, base, C) {
  const R = ansi.reset();
  let out = '';
  let i = 0;

  const assign = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/.exec(raw);
  if (assign) {
    out += C.assign + assign[0] + R;
    i = assign[0].length;
  }

  while (i < raw.length) {
    const c = raw[i];

    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      const stop = end === -1 ? raw.length : end + 1;
      out += C.string + raw.slice(i, stop) + R;
      i = stop;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let chunk = C.string + '"';
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\') { chunk += raw.slice(j, j + 2); j += 2; continue; }
        if (raw[j] === '$' || raw[j] === '`') {
          const span = expansionSpan(raw, j);
          chunk += R + C.variable + raw.slice(j, span) + R + C.string;
          j = span;
          continue;
        }
        chunk += raw[j];
        j++;
      }
      if (j < raw.length) { chunk += '"'; j++; }
      out += chunk + R;
      i = j;
      continue;
    }

    if (c === '$' || c === '`') {
      const span = expansionSpan(raw, i);
      if (span > i + 1 || c === '`') {
        out += C.variable + raw.slice(i, span) + R;
        i = span;
        continue;
      }
    }

    if (c === '\\' && i + 1 < raw.length) {
      out += base + raw.slice(i, i + 2) + R;
      i += 2;
      continue;
    }

    out += base + c + R;
    i++;
  }

  return out;
}

// End index of the expansion starting at `start` ($var, ${...}, $(...), `...`).
function expansionSpan(raw, start) {
  const c = raw[start];
  if (c === '`') {
    const end = raw.indexOf('`', start + 1);
    return end === -1 ? raw.length : end + 1;
  }
  const next = raw[start + 1];
  if (next === undefined) return start + 1;

  if (next === '{' || next === '(') {
    const open = next;
    const close = open === '{' ? '}' : ')';
    let depth = 0;
    for (let i = start + 1; i < raw.length; i++) {
      if (raw[i] === open) depth++;
      else if (raw[i] === close) { depth--; if (!depth) return i + 1; }
    }
    return raw.length;
  }

  if (/[A-Za-z_]/.test(next)) {
    let i = start + 1;
    while (i < raw.length && /[A-Za-z0-9_]/.test(raw[i])) i++;
    return i;
  }
  if ('@*#?$!-0123456789'.includes(next)) return start + 2;
  return start + 1;
}

function matchOperator(line, i) {
  for (const op of OPERATORS) if (line.startsWith(op, i)) return op;
  return null;
}

// Tolerant, never-throwing highlighter: it must cope with half-typed input.
function highlight(line, shell) {
  if (!ansi.isEnabled()) return line;

  const C = palette();
  const R = ansi.reset();
  let out = '';
  let i = 0;
  let commandSlot = true;

  while (i < line.length) {
    const c = line[i];

    if (c === ' ' || c === '\t') { out += c; i++; continue; }

    if (c === '#' && (i === 0 || ' \t;|&('.includes(line[i - 1]))) {
      out += C.comment + line.slice(i) + R;
      break;
    }

    const op = matchOperator(line, i);
    if (op) {
      out += C.operator + op + R;
      i += op.length;
      commandSlot = !REDIR_OPS.has(op);
      continue;
    }

    // Read one word, respecting quotes so spaces inside them don't split it.
    const start = i;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t') break;
      if (matchOperator(line, i)) break;
      if (ch === "'") {
        const end = line.indexOf("'", i + 1);
        i = end === -1 ? line.length : end + 1;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
        i = j < line.length ? j + 1 : line.length;
        continue;
      }
      if (ch === '\\') { i += 2; continue; }
      if (ch === '$' && (line[i + 1] === '(' || line[i + 1] === '{')) { i = expansionSpan(line, i); continue; }
      i++;
    }

    const raw = line.slice(start, i);
    const isAssign = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(raw);
    let base = C.arg;

    if (commandSlot && !isAssign) {
      base = C[classifyCommand(raw, shell)] ?? C.arg;
      commandSlot = false;
    }

    out += paintWord(raw, base, C);
  }

  return out;
}

module.exports = { highlight, classifyCommand };
