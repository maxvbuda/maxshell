'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Store, snippetsFile, marksFile } = require('./snippets');

// The command palette (Ctrl-P): everything maxshell can do right now, in one
// searchable list. Each item's `value` is a command line; `insert` items go
// onto the prompt to edit instead of running.

function shortPath(p) {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

const q = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

function paletteItems(shell) {
  const items = [];
  const add = (group, icon, label, desc, value, extra = {}) => items.push({ group, icon, label, desc, value, ...extra });

  // Jobs first: they're what you most likely want back.
  for (const job of shell.jobs || []) {
    job.poll();
    add('jobs', '⚙', `fg %${job.id}`, `${job.state} · ${job.cmd}`, `fg %${job.id}`);
  }

  add('tools', '✨', 'sage', 'ask Sage, the AI on your Mac (private, offline)', 'sage');
  add('tools', '🛠', 'sage code', 'Sage Code: build and fix this project with AI', 'sage code');
  add('tools', '📊', 'dash', 'live dashboard: git, jobs, CPU, memory, recent commands', 'dash');
  add('tools', '🗂', 'files', 'browse this folder, Finder-style', 'files');
  add('tools', '🌿', 'gitui', 'stage, diff, commit and push', 'gitui');
  add('tools', '📈', 'top', 'live process monitor', 'top');
  add('tools', '✏️', 'edit', 'open the editor', 'edit', { insert: true });
  add('tools', '📄', 'view', 'page through a file', 'view ', { insert: true });
  add('tools', '📌', 'mark', 'bookmark this folder', 'mark');
  add('tools', '🔖', 'go', 'jump to a bookmarked folder', 'go');
  add('tools', '✂️', 'snip', 'pick a saved snippet', 'snip');
  add('tools', '❓', 'help', 'the language at a glance', 'help');

  // Snippets and bookmarks.
  for (const [name, cmd] of new Store(snippetsFile()).entries()) add('snippets', '✂️', name, cmd, cmd, { insert: true });
  for (const [name, dir] of new Store(marksFile()).entries()) add('bookmarks', '🔖', name, shortPath(dir), `cd ${q(dir)}`);

  // This project's scripts and git.
  try {
    for (let dir = shell.cwd; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        for (const [name, script] of Object.entries(pkg.scripts || {})) add('npm', '▶', `npm run ${name}`, script, `npm run ${name}`);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  } catch { /* no project */ }
  if (fs.existsSync(path.join(shell.cwd, 'Makefile'))) {
    try {
      const targets = fs.readFileSync(path.join(shell.cwd, 'Makefile'), 'utf8').match(/^[A-Za-z0-9_.-]+(?=:(?!=))/gm) || [];
      for (const t of [...new Set(targets)].slice(0, 20)) add('make', '🔨', `make ${t}`, 'Makefile target', `make ${t}`);
    } catch { /* unreadable */ }
  }
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: shell.cwd, encoding: 'utf8', timeout: 800 }).stdout === 'true\n';
  if (inRepo) {
    for (const [cmd, desc] of [
      ['git status', 'what has changed'], ['git pull', 'fetch and integrate'], ['git push', 'upload commits'],
      ['git log --oneline -20', 'recent commits'], ['git diff', 'unstaged changes'], ['git stash', 'shelve changes'],
      ['git stash pop', 'bring shelved changes back'],
    ]) add('git', '⎇', cmd, desc, cmd);
    const res = spawnSync('git', ['for-each-ref', '--sort=-committerdate', '--count=8', '--format=%(refname:short)', 'refs/heads'], { cwd: shell.cwd, encoding: 'utf8', timeout: 800 });
    for (const b of (res.stdout || '').split('\n').filter(Boolean)) add('git', '⎇', `git switch ${b}`, 'switch branch', `git switch ${q(b)}`);
  }

  // Folders you visit most.
  try {
    const { DirDB } = require('./jump');
    for (const hit of new DirDB().query([], { cwd: shell.cwd }).slice(0, 12)) {
      add('folders', '📁', path.basename(hit.path) || '/', shortPath(hit.path), `cd ${q(hit.path)}`);
    }
  } catch { /* no folder history yet */ }

  // Themes.
  const theme = require('./theme');
  for (const name of theme.names()) {
    add('themes', '🎨', `theme ${name}`, theme.THEMES[name].description + (name === theme.currentThemeName() ? ' (current)' : ''), `theme ${name}`);
  }

  // Recent commands, once each.
  const seen = new Set();
  for (let i = shell.history.length - 1; i >= 0 && seen.size < 15; i--) {
    const cmd = shell.history[i];
    if (seen.has(cmd) || cmd.includes('\n')) continue;
    seen.add(cmd);
    add('recent', '↺', cmd, '', cmd, { insert: true });
  }
  return items;
}

module.exports = { paletteItems };
