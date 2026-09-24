'use strict';

const { spawnSync } = require('child_process');

const STATUS_LABEL = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'retyped',
  U: 'unmerged',
  '?': 'untracked',
};

function run(cwd, args, input) {
  let res;
  try {
    res = spawnSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, status: 1, stdout: '', stderr: e.message };
  }
  if (res.error) {
    return { ok: false, status: 1, stdout: '', stderr: res.error.message };
  }
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: (res.stderr || '').trim(),
  };
}

function isRepo(cwd) {
  return run(cwd, ['rev-parse', '--is-inside-work-tree']).ok;
}

function emptyStatus() {
  return {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    error: null,
  };
}

// Parses `git status --porcelain=2 --branch`. Each tracked entry carries two
// status characters: the staged one and the worktree one, so a file can show
// up in both lists at once.
function parseStatus(text) {
  const out = emptyStatus();

  for (const line of text.split('\n')) {
    if (!line) continue;

    if (line.startsWith('# branch.head ')) { out.branch = line.slice(14).trim(); continue; }
    if (line.startsWith('# branch.upstream ')) { out.upstream = line.slice(18).trim(); continue; }
    if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
      continue;
    }
    if (line.startsWith('# ') || line.startsWith('! ')) continue;

    if (line.startsWith('? ')) {
      out.untracked.push({ path: line.slice(2), code: '?', orig: null });
      continue;
    }

    if (line.startsWith('u ')) {
      const fields = line.split(' ');
      out.conflicted.push({ path: fields.slice(10).join(' '), code: 'U', orig: null });
      continue;
    }

    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const renamed = line.startsWith('2 ');
      const fields = line.split(' ');
      const xy = fields[1];
      const rest = fields.slice(renamed ? 9 : 8).join(' ');

      let path = rest;
      let orig = null;
      if (renamed) {
        const tab = rest.indexOf('\t');
        if (tab !== -1) { path = rest.slice(0, tab); orig = rest.slice(tab + 1); }
      }

      if (xy[0] !== '.') out.staged.push({ path, code: xy[0], orig });
      if (xy[1] !== '.') out.unstaged.push({ path, code: xy[1], orig });
    }
  }

  return out;
}

function status(cwd) {
  const res = run(cwd, ['status', '--porcelain=2', '--branch']);
  if (!res.ok) {
    const out = emptyStatus();
    out.error = res.stderr || 'not a git repository';
    return out;
  }
  return parseStatus(res.stdout);
}

function diff(cwd, entry, section) {
  if (section === 'untracked') {
    // --no-index exits 1 when the files differ, which is the normal case here.
    const res = run(cwd, ['diff', '--no-index', '--', '/dev/null', entry.path]);
    return res.stdout || res.stderr;
  }
  const args = ['diff'];
  if (section === 'staged') args.push('--cached');
  args.push('--', entry.path);
  const res = run(cwd, args);
  return res.ok ? res.stdout : res.stderr;
}

// True once the branch has a commit. Before that there is no HEAD to reset
// against, so unstaging has to remove from the index instead.
function hasCommits(cwd) {
  return run(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).ok;
}

// `reset`/`checkout` rather than `restore`, so older gits work too.
const stage = (cwd, path) => run(cwd, ['add', '--', path]);
const discard = (cwd, path) => run(cwd, ['checkout', '--', path]);
const stageAll = (cwd) => run(cwd, ['add', '-A']);

function unstage(cwd, path) {
  return hasCommits(cwd)
    ? run(cwd, ['reset', '-q', 'HEAD', '--', path])
    : run(cwd, ['rm', '--cached', '-q', '--', path]);
}

function unstageAll(cwd) {
  return hasCommits(cwd)
    ? run(cwd, ['reset', '-q', 'HEAD'])
    : run(cwd, ['rm', '-r', '--cached', '-q', '.']);
}
const commit = (cwd, message) => run(cwd, ['commit', '-m', message]);
const push = (cwd, args = []) => run(cwd, ['push', ...args]);
const log = (cwd, n = 10) => run(cwd, ['log', '--oneline', '-n', String(n)]).stdout;

function describeRemote(cwd) {
  const res = run(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  return res.ok ? res.stdout.trim() : null;
}

module.exports = {
  run,
  isRepo,
  hasCommits,
  status,
  parseStatus,
  emptyStatus,
  diff,
  stage,
  unstage,
  discard,
  stageAll,
  unstageAll,
  commit,
  push,
  log,
  describeRemote,
  STATUS_LABEL,
};
