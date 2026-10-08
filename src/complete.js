'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { BUILTINS } = require('./builtins');
const { RESERVED } = require('./lexer');
const { humanBytes } = require('./tui');

function commonPrefix(items) {
  if (!items.length) return '';
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

// --- what things are, for the completion menu ---------------------------------------

const BUILTIN_DESC = {
  cd: 'change directory', pwd: 'print the current directory', echo: 'print text', print: 'print text',
  printf: 'formatted output', export: 'set an environment variable', unset: 'remove a variable',
  alias: 'define a shortcut', unalias: 'remove a shortcut', source: 'run a script here', '.': 'run a script here',
  eval: 'run a string as code', exit: 'leave maxshell', history: 'show past commands', help: 'the language at a glance',
  read: 'read a line of input', set: 'shell options', shift: 'drop positional arguments', test: 'check a condition',
  '[': 'check a condition', type: 'what is this name?', which: 'where is this command?', whence: 'what is this name?',
  local: 'function-local variable', declare: 'declare a variable', typeset: 'declare a variable', let: 'arithmetic',
  pushd: 'push a directory', popd: 'pop a directory', dirs: 'the directory stack', jobs: 'background jobs',
  command: 'run a program, skipping functions', true: 'succeed', false: 'fail', ':': 'do nothing',
  edit: 'nano-style editor with highlighting', pyedit: 'the editor in Python mode', view: 'pager with highlighting',
  files: 'Finder-style file browser', top: 'live process monitor', gitui: 'stage, diff, commit and push',
  j: 'jump to a frequent folder', back: 'previous folder', forward: 'next folder', theme: 'switch colour theme',
  break: 'leave a loop', continue: 'next loop iteration', return: 'leave a function', unfunction: 'remove a function',
  ls: 'list files (icons and git status at the prompt)', gitui: 'stage, diff, commit and push', fg: 'bring a job back',
  bg: 'continue a job in the background', kill: 'signal a process or job', wait: 'wait for background jobs',
  disown: 'forget a job', trap: 'run code on a signal or exit', getopts: 'parse options', setopt: 'turn options on',
  unsetopt: 'turn options off', readonly: 'a variable that can’t change', integer: 'an integer variable',
  float: 'a floating-point variable', builtin: 'run a builtin', where: 'every meaning of a name', abbr: 'expanding abbreviations',
  emulate: 'accepted for zsh scripts', dash: 'live dashboard', palette: 'the command palette (Ctrl-P)',
  explain: 'what a command line will do', snip: 'saved command snippets', mark: 'bookmark this folder',
  go: 'jump to a bookmarked folder', cleanup: 'quit what isn’t needed; -r memory, -c CPU', '6-7': 'brainrot mode 🤷', bot: 'chat with a rules-only bot', ai: 'chat with mx, the on-device AI', sage: 'Sage, the AI on your Mac — sage code edits files',
};

const COMMAND_DESC = {
  ls: 'list files', cat: 'print files', grep: 'search text', find: 'find files', mkdir: 'make directories',
  rm: 'remove files', mv: 'move or rename', cp: 'copy', touch: 'create an empty file', less: 'page through text',
  head: 'first lines', tail: 'last lines', git: 'version control', node: 'run JavaScript', npm: 'Node packages',
  npx: 'run a package binary', python3: 'run Python', pip3: 'Python packages', brew: 'Homebrew packages',
  curl: 'transfer a URL', ssh: 'remote shell', open: 'open with the default app', code: 'Visual Studio Code',
  claude: 'Claude Code', make: 'build with a Makefile', docker: 'containers', clear: 'clear the screen',
  chmod: 'change permissions', sudo: 'run as administrator', vim: 'Vim', nano: 'nano', man: 'manual pages',
  diff: 'compare files', wc: 'count lines and words', sort: 'sort lines', uniq: 'unique lines', gh: 'GitHub CLI',
};

const SUBCOMMANDS = {
  git: {
    add: 'stage changes', branch: 'list, create or delete branches', checkout: 'switch branches or restore files',
    'cherry-pick': 'apply one commit here', clone: 'copy a repository', commit: 'record staged changes',
    config: 'read and write settings', diff: 'show changes', fetch: 'download from a remote', init: 'start a repository',
    log: 'commit history', merge: 'join two histories', mv: 'move a tracked file', pull: 'fetch and integrate',
    push: 'upload commits', rebase: 'replay commits on a new base', remote: 'manage remotes', reset: 'move HEAD back',
    restore: 'restore files', revert: 'undo a commit with a new one', rm: 'remove tracked files', show: 'show an object',
    stash: 'shelve changes', status: 'what has changed', switch: 'switch branches', tag: 'name a commit',
  },
  npm: {
    audit: 'check for vulnerabilities', ci: 'clean install from the lockfile', init: 'create package.json',
    install: 'add dependencies', link: 'link a local package', list: 'installed packages', outdated: 'what can update',
    publish: 'publish to the registry', run: 'run a package script', start: 'run the start script', test: 'run the tests',
    uninstall: 'remove a dependency', update: 'update dependencies', version: 'bump the version',
  },
  brew: {
    cleanup: 'remove old versions', doctor: 'check for problems', info: 'about a formula', install: 'install a formula',
    list: 'installed formulae', outdated: 'what can upgrade', search: 'find formulae', uninstall: 'remove a formula',
    update: 'refresh Homebrew', upgrade: 'upgrade formulae',
  },
  docker: {
    build: 'build an image', compose: 'multi-container apps', exec: 'run in a container', images: 'list images',
    logs: 'container output', ps: 'running containers', pull: 'download an image', run: 'start a container',
    stop: 'stop a container',
  },
  cargo: {
    add: 'add a dependency', build: 'compile', check: 'type-check', run: 'build and run', test: 'run the tests',
    new: 'create a project', fmt: 'format code', clippy: 'lint',
  },
  gh: {
    auth: 'log in', issue: 'issues', pr: 'pull requests', release: 'releases', repo: 'repositories', run: 'workflow runs',
  },
};
SUBCOMMANDS.pnpm = SUBCOMMANDS.npm;
SUBCOMMANDS.sage = { code: 'Sage Code: build and fix this project', image: 'draw a picture, or edit yours (--edit photo.jpg)', video: 'film a short clip, or bring a picture to life', '--ultra': 'Sage Ultra, the best at code', '--pro': 'Sage Pro, the all-rounder', '--lite': 'Sage Lite, the fastest', '--setup': 'install what Sage needs', '--help': 'what sage can do' };
SUBCOMMANDS.yarn = { add: 'add a dependency', install: 'install dependencies', run: 'run a script', remove: 'remove a dependency' };

const BRANCH_ARGS = { git: new Set(['checkout', 'switch', 'merge', 'rebase', 'branch', 'diff', 'log']) };
const DIR_ONLY = new Set(['cd', 'pushd', 'j', 'files']);

function branches(cwd) {
  const res = spawnSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], {
    cwd, encoding: 'utf8', timeout: 800,
  });
  if (res.error || res.status !== 0) return [];
  return res.stdout.split('\n').filter((b) => b && !b.endsWith('/HEAD'));
}

// The scripts in the nearest package.json, with what each runs.
function npmScripts(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return pkg.scripts || {};
    } catch { /* keep walking up */ }
    if (path.dirname(dir) === dir) return {};
  }
}

// Splits the text before the cursor into the words of the current command.
function currentWords(before) {
  const seg = before.split(/[|;&(]|\b(?:then|do|else|elif)\s/).pop();
  return seg.trim() ? seg.trim().split(/\s+/) : [];
}

// Where the word under the cursor starts, reading quotes and backslashes
// the way the shell does, and whether it's inside an open quote.
function wordAtCursor(upto) {
  let start = 0;
  let q = null;
  for (let i = 0; i < upto.length; i++) {
    const c = upto[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') q = null;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (/\s/.test(c) || '|;&()<>'.includes(c)) start = i + 1;
  }
  const raw = upto.slice(start);
  // What the word means once its quotes and escapes are taken away.
  let value = '';
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote === "'") { if (c === "'") quote = null; else value += c; continue; }
    if (quote === '"') {
      if (c === '\\' && i + 1 < raw.length && '"\\$`'.includes(raw[i + 1])) { value += raw[++i]; continue; }
      if (c === '"') quote = null; else value += c;
      continue;
    }
    if (c === '\\') { if (i + 1 < raw.length) value += raw[++i]; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    value += c;
  }
  return { start, raw, value, quote: q };
}

const SPECIAL = /[\s'"\\$`&|;<>()*?[\]{}!#]/g;

// How a completed word goes back on the line: escaped when bare, or kept in
// the quotes you opened (closed again once a file name is complete).
function quoteFor(text, quote, finished) {
  if (quote === "'") return `'${text.replace(/'/g, "'\\''")}${finished ? "'" : ''}`;
  if (quote === '"') return `"${text.replace(/["\\$`]/g, '\\$&')}${finished ? '"' : ''}`;
  const tilde = /^~(?=\/|$)/.test(text) ? '~' : '';
  return tilde + text.slice(tilde.length).replace(SPECIAL, '\\$&');
}

const AFTER_PREFIX = new Set(['sudo', 'time', 'command', 'builtin', 'exec', 'nohup', 'noglob', 'env', 'xargs', 'watch', 'nice', 'which', 'type', 'whence', 'man']);

// Completions for the word ending at `cursor`: the candidates, the partial
// word they replace, and for each an icon and a short description.
function completions(line, cursor, shell) {
  const upto = line.slice(0, cursor);
  const word = wordAtCursor(upto);
  const partial = word.raw;
  const want = word.value;
  const before = upto.slice(0, word.start);
  const words = currentWords(before);
  const cmd = words[0];
  const argIndex = words.length;
  const isCommandSlot = /(^|[|&;(]|\b(?:do|then|else|elif)\s)\s*$/.test(before)
    || (argIndex === 1 && AFTER_PREFIX.has(cmd) && !want.startsWith('-'));

  // Candidates are plain values; they're quoted for the line at the end.
  const info = new Map();
  const add = (value, icon, desc, finished = true) => {
    if (!info.has(value)) info.set(value, { icon, desc, finished });
  };
  const finish = () => {
    const values = [...info.keys()].filter((c) => c.startsWith(want)).sort((a, b) => a.localeCompare(b));
    const out = new Map();
    for (const v of values) {
      const meta = info.get(v);
      const text = meta.raw ? v : quoteFor(v, word.quote, meta.finished);
      out.set(text, { ...meta, label: v });
    }
    return { items: [...out.keys()], partial, info: out };
  };

  // $name and ${name
  const dollar = /^(\$\{?)([A-Za-z_][A-Za-z0-9_]*)?$/.exec(want);
  if (dollar && partial.startsWith('$')) {
    const names = new Set([...Object.keys(shell.env), ...shell.scopes.flatMap((sc) => [...sc.keys()])]);
    const brace = dollar[1] === '${';
    for (const n of names) {
      const entry = shell.findEntry(n);
      const v = entry ? entry.value : shell.env[n];
      const shown = Array.isArray(v) ? `(${v.join(' ')})` : v instanceof Map ? `(${[...v.keys()].join(' ')})` : String(v ?? '');
      info.set(`${dollar[1]}${n}${brace ? '}' : ''}`, { icon: '$', desc: shown.replace(/\s+/g, ' ').slice(0, 60), raw: true });
    }
    return finish();
  }

  if (isCommandSlot && !want.includes('/')) {
    for (const name of Object.keys(BUILTINS)) add(name, '◆', BUILTIN_DESC[name] || 'builtin');
    for (const name of shell.funcs.keys()) add(name, 'ƒ', 'function');
    for (const [name, value] of shell.aliases) add(name, '↪', `alias for ${value}`);
    if (shell.abbrs) for (const [name, value] of shell.abbrs) add(name, '↪', `abbreviation for ${value}`);
    for (const name of RESERVED) if (/^[a-z]+$/.test(name)) add(name, '•', 'keyword');
    for (const dir of (shell.env.PATH || '').split(':').filter(Boolean)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) if (name.startsWith(want)) add(name, '▸', COMMAND_DESC[name] || 'command');
    }
    return finish();
  }

  if (cmd === 'theme' && argIndex === 1) {
    const { THEMES } = require('./theme');
    for (const [name, t] of Object.entries(THEMES)) add(name, '🎨', t.description);
    return finish();
  }

  if (['fg', 'bg', 'kill', 'wait', 'disown'].includes(cmd) && want.startsWith('%')) {
    for (const job of shell.jobs || []) add(`%${job.id}`, '⚙', job.cmd);
    return finish();
  }

  if (['setopt', 'unsetopt'].includes(cmd)) {
    for (const o of ['autocd', 'nullglob', 'globdots', 'shwordsplit', 'globsubst', 'errexit', 'nounset', 'xtrace', 'pipefail', 'noglob', 'nomatch', 'chaselinks', 'ignorebraces']) add(o, '⚑', 'option');
    return finish();
  }

  if (SUBCOMMANDS[cmd] && argIndex === 1) {
    for (const [sub, desc] of Object.entries(SUBCOMMANDS[cmd])) add(sub, '›', desc);
    return finish();
  }

  if (['npm', 'pnpm', 'yarn'].includes(cmd) && words[1] === 'run' && argIndex === 2) {
    for (const [name, script] of Object.entries(npmScripts(shell.cwd))) add(name, '▶', script);
    return finish();
  }

  if (BRANCH_ARGS[cmd] && BRANCH_ARGS[cmd].has(words[1]) && argIndex >= 2 && !want.startsWith('-')) {
    for (const b of branches(shell.cwd)) add(b, '⎇', b.includes('/') ? 'remote branch' : 'branch');
    // Files still make sense for diff and log.
    if (!['diff', 'log'].includes(words[1])) return finish();
  }

  // Paths, described the way the file browser describes them.
  const dirsOnly = DIR_ONLY.has(cmd);
  const slash = want.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : want.slice(0, slash + 1);
  const basePart = slash === -1 ? want : want.slice(slash + 1);
  try {
    const home = shell.getVar('HOME') || os.homedir();
    const base = dirPart ? shell.resolve(dirPart.replace(/^~(?=\/|$)/, home)) : shell.cwd;
    const { describe } = require('./files');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.name.startsWith(basePart)) continue;
      if (!basePart && entry.name.startsWith('.')) continue;
      let st = null;
      try { st = fs.statSync(path.join(base, entry.name)); } catch { /* broken link */ }
      const isDir = st ? st.isDirectory() : entry.isDirectory();
      if (dirsOnly && !isDir) continue;
      const d = describe({ name: entry.name, isDir, isLink: entry.isSymbolicLink(), exec: !!st && (st.mode & 0o111) && !isDir, broken: !st });
      const desc = isDir ? 'folder' : `${d.kind} · ${humanBytes(st ? st.size : 0)}`;
      add(dirPart + entry.name + (isDir ? '/' : ''), d.icon, desc, !isDir);
    }
  } catch { /* not a directory */ }

  return finish();
}

module.exports = { completions, commonPrefix, wordAtCursor, quoteFor, SUBCOMMANDS, BUILTIN_DESC, COMMAND_DESC };
