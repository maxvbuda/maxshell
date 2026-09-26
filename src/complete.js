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

// Completions for the word ending at `cursor`: the candidates, the partial
// word they replace, and for each an icon and a short description.
function completions(line, cursor, shell) {
  const upto = line.slice(0, cursor);
  const match = /(\S*)$/.exec(upto);
  const partial = match ? match[1] : '';
  const before = upto.slice(0, upto.length - partial.length);
  const isCommandSlot = /(^|[|&;(]|\b(?:do|then|else|elif)\s)\s*$/.test(before);
  const words = currentWords(before);
  const cmd = words[0];
  const argIndex = words.length;

  const info = new Map();
  const add = (item, icon, desc) => { if (!info.has(item)) info.set(item, { icon, desc }); };
  const finish = () => {
    const items = [...info.keys()].filter((c) => c.startsWith(partial)).sort((a, b) => a.localeCompare(b));
    return { items, partial, info };
  };

  if (isCommandSlot && !partial.includes('/')) {
    for (const name of Object.keys(BUILTINS)) add(name, '◆', BUILTIN_DESC[name] || 'builtin');
    for (const name of shell.funcs.keys()) add(name, 'ƒ', 'function');
    for (const [name, value] of shell.aliases) add(name, '↪', `alias for ${value}`);
    for (const name of RESERVED) if (/^[a-z]+$/.test(name)) add(name, '•', 'keyword');
    for (const dir of (shell.env.PATH || '').split(':').filter(Boolean)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) if (name.startsWith(partial)) add(name, '▸', COMMAND_DESC[name] || 'command');
    }
    return finish();
  }

  if (cmd === 'theme' && argIndex === 1) {
    const { THEMES } = require('./theme');
    for (const [name, t] of Object.entries(THEMES)) add(name, '🎨', t.description);
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

  if (BRANCH_ARGS[cmd] && BRANCH_ARGS[cmd].has(words[1]) && argIndex >= 2 && !partial.startsWith('-')) {
    for (const b of branches(shell.cwd)) add(b, '⎇', b.includes('/') ? 'remote branch' : 'branch');
    // Files still make sense for diff and log.
    if (!['diff', 'log'].includes(words[1])) return finish();
  }

  // Paths, described the way the file browser describes them.
  const dirsOnly = DIR_ONLY.has(cmd);
  const slash = partial.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : partial.slice(0, slash + 1);
  const basePart = slash === -1 ? partial : partial.slice(slash + 1);
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
      add(dirPart + entry.name + (isDir ? '/' : ''), d.icon, desc);
    }
  } catch { /* not a directory */ }

  return finish();
}

module.exports = { completions, commonPrefix, SUBCOMMANDS, BUILTIN_DESC };
