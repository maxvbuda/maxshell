'use strict';

const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const { Parser } = require('./parser');
const { expandWord } = require('./expand');
const { fit, textWidth } = require('./tui');

// Alt-H / `explain`: what a command line will do, piece by piece — each
// program and what it is, each flag as its manual describes it, what globs
// and variables expand to, and what the operators and redirections mean.
// Nothing is run (command substitutions are described, not executed).

const OPERATORS = {
  '|': 'sends its output into',
  '|&': 'sends its output and errors into',
  '&&': 'then, if that worked,',
  '||': 'or, if that failed,',
  ';': 'then',
  '&': 'in the background',
};

const REDIRECTS = {
  '>': (t) => `writes output to ${t}, replacing it`,
  '>>': (t) => `adds output to the end of ${t}`,
  '<': (t) => `reads input from ${t}`,
  '&>': (t) => `writes output and errors to ${t}`,
  '&>>': (t) => `adds output and errors to ${t}`,
  '<<<': (t) => `feeds in the text ${t}`,
  '<<': () => 'feeds in the here-document that follows',
  '<<-': () => 'feeds in the here-document that follows',
};

const manCache = new Map();

// The manual page as plain text (cached).
function manPage(name) {
  if (manCache.has(name)) return manCache.get(name);
  let text = '';
  if (/^[\w.+-]+$/.test(name)) {
    const res = spawnSync('sh', ['-c', `man ${name} 2>/dev/null | col -b`], {
      encoding: 'utf8', timeout: 3000, env: { ...process.env, MANPAGER: 'cat', MANWIDTH: '200', PAGER: 'cat' },
    });
    text = res.stdout || '';
  }
  manCache.set(name, text);
  return text;
}

// One-line summary of a program, from the NAME section of its manual.
function manSummary(name) {
  const text = manPage(name);
  const m = /^NAME\s*\n\s+(.+?)\s+[–—-]+\s+(.+)$/m.exec(text);
  return m ? m[2].trim() : null;
}

// What the manual says about one flag: the paragraph under the line that
// introduces it.
function flagHelp(page, flag) {
  if (!page) return null;
  const lines = page.split('\n');
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The flag at the start of a line, followed by what introduces its
  // description (spacing, an argument, or its long spelling) — not a line
  // that merely continues a sentence.
  const re = new RegExp(`^\\s{1,12}(?:-\\w,\\s+)?${esc}(?=$|\\s{2}|\\t|=|,\\s*--|\\s[<[]|\\s[A-Za-z_]+(?:$|\\s{2}|,))`);
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    // Text on the same line after the flag (and its argument), or the next lines.
    let rest = lines[i].replace(re, '');
    // Drop the argument and any other spellings: " <msg>, --message=<msg>".
    for (let k = 0; k < 4; k++) {
      rest = rest.replace(/^[=,\s]*(--?[\w-]+(=\S+)?|<[^>]*>|\[[^\]]*\]|[A-Z_]{2,}(?=\s|$)|[a-z_]+(?=\s{2}|$|,))/, '');
    }
    rest = rest.trim();
    let j = i + 1;
    while (!rest && j < lines.length && lines[j].trim()) { rest = lines[j].trim(); j++; }
    if (rest && !/^-/.test(rest)) {
      // Complete the first sentence from the following lines.
      while (!/[.:]\s*$/.test(rest) && j < lines.length && lines[j].trim() && !/^\s{1,12}-/.test(lines[j]) && rest.length < 160) {
        rest += ` ${lines[j].trim()}`;
        j++;
      }
      return rest.replace(/\s+/g, ' ').replace(/^(.{0,200}?[.:])\s.*$/, '$1');
    }
  }
  return null;
}

function describeCommand(name, shell) {
  const { BUILTINS } = require('./builtins');
  const { BUILTIN_DESC, SUBCOMMANDS } = require('./complete');
  if (shell.aliases.has(name)) return { kind: 'alias', text: `alias for ${shell.aliases.get(name)}` };
  if (shell.funcs.has(name)) return { kind: 'function', text: 'a function you defined' };
  if (BUILTINS[name]) return { kind: 'builtin', text: BUILTIN_DESC[name] || 'maxshell builtin' };
  const { findInPath } = require('./builtins');
  const where = findInPath(name, shell);
  if (!where) return { kind: 'missing', text: 'not found — nothing by this name is installed' };
  const summary = manSummary(name) || (SUBCOMMANDS[name] ? 'has subcommands' : 'program');
  return { kind: 'program', text: `${summary} · ${where}` };
}

// Explains one simple command: returns rows of [term, explanation, kind].
function explainSimple(node, shell, rows, depth) {
  const { SUBCOMMANDS } = require('./complete');
  const pad = '  '.repeat(depth);
  for (const a of node.assigns) rows.push([`${pad}${a.name}=…`, 'sets a variable for this command', 'assign']);
  if (!node.words.length) return;
  const raw = node.words.map((w) => w.value ?? '');
  const cmdName = raw[0];
  const d = describeCommand(cmdName, shell);
  rows.push([`${pad}${cmdName}`, d.text, d.kind]);

  let page = null;
  let sub = null;
  for (let i = 1; i < node.words.length; i++) {
    const w = node.words[i];
    const text = raw[i];
    if (i === 1 && SUBCOMMANDS[cmdName] && SUBCOMMANDS[cmdName][text]) {
      sub = text;
      rows.push([`${pad}  ${text}`, SUBCOMMANDS[cmdName][text], 'sub']);
      continue;
    }
    if (/^--?[\w-]/.test(text) && !w.quoted) {
      if (page === null) page = (sub && manPage(`${cmdName}-${sub}`)) || manPage(cmdName);
      const flag = text.replace(/=.*$/, '');
      const help = flagHelp(page, flag);
      if (!help && /^-\w{2,}$/.test(flag)) {
        // -la: each letter is its own flag.
        rows.push([`${pad}  ${text}`, 'several options together:', 'flag']);
        for (const c of flag.slice(1)) rows.push([`${pad}    -${c}`, flagHelp(page, `-${c}`) || 'an option', 'flag']);
        continue;
      }
      rows.push([`${pad}  ${text}`, help || 'an option (no description found in the manual)', 'flag']);
      continue;
    }
    if (w.parts && w.parts.some((p) => p.t === 'cmd')) {
      rows.push([`${pad}  ${text}`, 'runs a command and uses its output here (not run now)', 'expand']);
      continue;
    }
    let expanded = null;
    try { expanded = expandWord(shell, w); } catch { expanded = null; }
    const dynamic = w.parts && w.parts.some((p) => p.t !== 'lit');
    if (expanded && (dynamic || expanded.length !== 1 || expanded[0] !== text)) {
      const shown = expanded.length > 6 ? `${expanded.slice(0, 6).join(' ')} … (${expanded.length} in all)` : expanded.join(' ') || '(nothing)';
      const what = /[*?[]/.test(text) && !w.quoted ? `matches ${expanded.length === 1 && expanded[0] === text ? 'nothing (stays as typed)' : shown}` : `→ ${shown}`;
      rows.push([`${pad}  ${text}`, what, 'expand']);
    } else {
      rows.push([`${pad}  ${text}`, 'argument', 'arg']);
    }
  }
  for (const r of node.redirects) {
    const target = r.target ? (r.target.value ?? '') : '';
    let text;
    if (r.op === '>&' || r.op === '<&') {
      text = target === '1' ? 'errors go where the output goes' : target === '2' ? 'output goes where errors go' : `duplicates onto ${target}`;
    } else {
      text = (REDIRECTS[r.op] || ((t) => `redirects to ${t}`))(target);
      if (r.fd === 2) text = text.replace(/^writes output/, 'writes errors').replace(/^adds output/, 'adds errors');
    }
    const shown = r.op === '>&' || r.op === '<&' ? `${r.fd ?? ''}${r.op}${target}` : `${r.fd ?? ''}${r.op} ${target}`;
    rows.push([`${pad}  ${shown}`.trimEnd(), text, 'redirect']);
  }
}

function explainNode(node, shell, rows, depth = 0) {
  if (!node) return;
  const pad = '  '.repeat(depth);
  switch (node.type) {
    case 'List':
      node.items.forEach((it, i) => {
        explainNode(it.node, shell, rows, depth);
        if (it.sep === '&') rows.push([`${pad}&`, OPERATORS['&'], 'op']);
        else if (i < node.items.length - 1) rows.push([`${pad};`, OPERATORS[';'], 'op']);
      });
      break;
    case 'AndOr':
      explainNode(node.left, shell, rows, depth);
      rows.push([`${pad}${node.op}`, OPERATORS[node.op], 'op']);
      explainNode(node.right, shell, rows, depth);
      break;
    case 'Pipeline':
      if (node.negate) rows.push([`${pad}!`, 'reverses success and failure', 'op']);
      node.commands.forEach((c, i) => {
        explainNode(c, shell, rows, depth);
        if (i < node.commands.length - 1) rows.push([`${pad}${c.pipeStderr ? '|&' : '|'}`, c.pipeStderr ? OPERATORS['|&'] : OPERATORS['|'], 'op']);
      });
      break;
    case 'Simple': explainSimple(node, shell, rows, depth); break;
    case 'For': case 'Select':
      rows.push([`${pad}${node.type === 'For' ? 'for' : 'select'} ${node.name}`, 'repeats the body for each item', 'reserved']);
      explainNode(node.body, shell, rows, depth + 1);
      break;
    case 'ForArith': rows.push([`${pad}for ((…))`, 'counts through a loop', 'reserved']); explainNode(node.body, shell, rows, depth + 1); break;
    case 'While': rows.push([`${pad}${node.until ? 'until' : 'while'}`, `repeats the body ${node.until ? 'until' : 'while'} the condition holds`, 'reserved']); explainNode(node.cond, shell, rows, depth + 1); explainNode(node.body, shell, rows, depth + 1); break;
    case 'If': rows.push([`${pad}if`, 'runs the first branch whose condition succeeds', 'reserved']); node.clauses.forEach((c) => { explainNode(c.cond, shell, rows, depth + 1); explainNode(c.body, shell, rows, depth + 1); }); break;
    case 'Group': case 'Subshell': rows.push([`${pad}${node.type === 'Group' ? '{ … }' : '( … )'}`, node.type === 'Group' ? 'runs these together' : 'runs these in a subshell (changes stay inside)', 'reserved']); explainNode(node.body, shell, rows, depth + 1); break;
    case 'Cond': rows.push([`${pad}[[ … ]]`, 'tests a condition', 'reserved']); break;
    case 'ArithCmd': rows.push([`${pad}(( … ))`, 'arithmetic; succeeds if the result is not zero', 'reserved']); break;
    case 'FunctionDef': rows.push([`${pad}${node.name}()`, 'defines a function', 'reserved']); break;
    case 'Repeat': rows.push([`${pad}repeat`, 'runs the body a number of times', 'reserved']); explainNode(node.body, shell, rows, depth + 1); break;
    case 'Case': rows.push([`${pad}case`, 'picks a branch by matching patterns', 'reserved']); break;
    default: rows.push([`${pad}${node.type}`, '', 'arg']);
  }
}

// Rows of [term, explanation, kind] for a whole command line.
function explainRows(line, shell) {
  const rows = [];
  let ast;
  try {
    ast = new Parser(line, { aliases: { aliases: shell.aliases, galiases: shell.galiases, saliases: shell.saliases } }).parseProgram();
  } catch (e) {
    return [['', `can't read this yet: ${e.message}`, 'missing']];
  }
  explainNode(ast, shell, rows);
  return rows;
}

// The explanation as coloured lines that fit `cols`.
function explain(line, shell, cols = 80) {
  const t = theme.current();
  const R = ansi.reset();
  const colour = {
    program: t.shell.command, builtin: t.shell.builtin, function: t.shell.command, alias: t.shell.alias,
    missing: t.ui.err, sub: t.ui.accent, flag: t.ui.accent2, expand: t.shell.variable, redirect: t.shell.operator,
    op: t.shell.operator, reserved: t.shell.reserved, assign: t.shell.assign, arg: t.ui.muted,
  };
  const rows = explainRows(line, shell);
  const termW = Math.min(Math.max(8, ...rows.map((r) => textWidth(r[0]))), Math.floor(cols * 0.4));
  return rows.map(([term, text, kind]) => {
    const head = `${theme.style(colour[kind] ?? t.ui.muted)}${fit(term, termW)}${R}  `;
    return `${head}${ansi.fg(t.ui.muted)}${fit(text, Math.max(0, cols - 1 - termW - 2)).trimEnd()}${R}`;
  });
}

module.exports = { explain, explainRows, flagHelp, manSummary };
