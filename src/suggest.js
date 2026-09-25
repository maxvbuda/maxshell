'use strict';

const fs = require('fs');
const path = require('path');

// "Did you mean …?" for mistyped commands.

// Edit distance counting a swap of two neighbours as one edit ("gti" → "git").
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return Math.abs(m - n);
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Common commands win ties, so "sl" suggests "ls" before something obscure.
const COMMON = [
  'ls', 'cd', 'git', 'cat', 'grep', 'mkdir', 'rm', 'mv', 'cp', 'echo', 'node', 'npm', 'npx',
  'python3', 'python', 'pip', 'pip3', 'brew', 'code', 'open', 'clear', 'touch', 'less',
  'head', 'tail', 'find', 'curl', 'ssh', 'make', 'docker', 'cargo', 'go', 'java', 'gh',
  'vim', 'nano', 'edit', 'view', 'files', 'top', 'gitui', 'pyedit', 'claude', 'history',
];

const SUBCOMMANDS = {
  git: ['add', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit', 'config', 'diff', 'fetch',
    'init', 'log', 'merge', 'mv', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'revert',
    'rm', 'show', 'stash', 'status', 'switch', 'tag'],
  npm: ['audit', 'ci', 'init', 'install', 'link', 'list', 'outdated', 'publish', 'run', 'start',
    'test', 'uninstall', 'update', 'version'],
  brew: ['cleanup', 'doctor', 'info', 'install', 'list', 'outdated', 'reinstall', 'search',
    'services', 'uninstall', 'update', 'upgrade'],
  docker: ['build', 'compose', 'exec', 'images', 'logs', 'ps', 'pull', 'push', 'rm', 'rmi', 'run',
    'start', 'stop'],
  cargo: ['add', 'build', 'check', 'clean', 'doc', 'fmt', 'init', 'install', 'new', 'run', 'test',
    'update'],
  pip: ['download', 'freeze', 'install', 'list', 'show', 'uninstall'],
  gh: ['auth', 'issue', 'pr', 'release', 'repo', 'run', 'workflow'],
};
SUBCOMMANDS.pip3 = SUBCOMMANDS.pip;

let pathCache = { key: null, names: [] };

function pathCommands(envPath) {
  if (pathCache.key === envPath) return pathCache.names;
  const names = new Set();
  for (const dir of (envPath || '').split(':').filter(Boolean)) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const n of entries) names.add(n);
  }
  pathCache = { key: envPath, names: [...names] };
  return pathCache.names;
}

function knownCommands(shell) {
  const { BUILTINS } = require('./builtins');
  const names = new Set([...Object.keys(BUILTINS), ...COMMON]);
  if (shell.funcs) for (const n of shell.funcs.keys()) names.add(n);
  if (shell.aliases) for (const n of shell.aliases.keys()) names.add(n);
  for (const n of pathCommands(shell.env && shell.env.PATH)) names.add(n);
  return names;
}

// The closest word from `candidates` to `word`, or null if nothing is close.
function closest(word, candidates, { common = [] } = {}) {
  const allowed = word.length <= 3 ? 1 : 2;
  let best = null;
  for (const c of candidates) {
    if (c === word || Math.abs(c.length - word.length) > allowed) continue;
    const dist = editDistance(word, c);
    if (dist > allowed) continue;
    const rank = [dist, common.includes(c) ? 0 : 1, Math.abs(c.length - word.length), c];
    if (!best || compareRank(rank, best.rank) < 0) best = { word: c, rank };
  }
  return best && best.word;
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function suggestCommand(name, shell) {
  if (!name || name.includes('/')) return null;
  return closest(name, knownCommands(shell), { common: COMMON });
}

// Corrects a whole command line: the command name, then a known
// subcommand ("gti stauts" → "git status"). Only simple lines are touched.
function suggestLine(line, shell) {
  const m = /^(\s*)(\S+)(.*)$/s.exec(line);
  if (!m || line.includes('\n')) return null;
  const [, lead, first, rest] = m;
  const known = knownCommands(shell);
  const cmd = known.has(first) ? first : closest(first, known, { common: COMMON });
  if (!cmd) return null;
  let tail = rest;
  const sub = /^(\s+)([A-Za-z][\w-]*)(.*)$/s.exec(rest);
  if (sub && SUBCOMMANDS[cmd] && !SUBCOMMANDS[cmd].includes(sub[2])) {
    const fixed = closest(sub[2], SUBCOMMANDS[cmd]);
    if (fixed) tail = `${sub[1]}${fixed}${sub[3]}`;
  }
  const out = `${lead}${cmd}${tail}`;
  return out === line ? null : out;
}

module.exports = { editDistance, closest, suggestCommand, suggestLine, knownCommands, SUBCOMMANDS };
