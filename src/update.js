'use strict';

// `maxshell --update`: replaces this maxshell folder with the newest version
// from GitHub. The new copy is downloaded and checked first, so a failed
// download leaves everything as it was; then the old folder goes to the
// Trash (not deleted, so it can be dragged back) and the new one takes its
// place at the same path — commands and login wrappers pointing there keep
// working. A git checkout is never replaced: it's updated with `git pull`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const URL = 'https://github.com/maxvbuda/maxshell/archive/refs/heads/main.zip';

function trashDir() {
  const dir = process.env.MAXSHELL_TRASH || path.join(require('os').homedir(), '.Trash');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function move(from, to) {
  try { fs.renameSync(from, to); } catch {
    const r = spawnSync('mv', [from, to]);
    if (r.status !== 0) throw new Error(`couldn’t move ${from}`);
  }
}

function version(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return '?'; }
}

function update({ root = path.resolve(__dirname, '..'), url = process.env.MAXSHELL_UPDATE_URL || URL, say = (t) => process.stdout.write(t) } = {}) {
  const before = version(root);
  if (fs.existsSync(path.join(root, '.git'))) {
    say(`${root} is a git checkout, so updating it with git pull:\n`);
    const r = spawnSync('git', ['-C', root, 'pull', '--ff-only'], { stdio: 'inherit' });
    if (r.status !== 0) { say('✗ git pull failed — nothing was changed\n'); return 1; }
    say(`✓ maxshell ${before} → ${version(root)}\n`);
    return 0;
  }
  // Work next to the install, so the final moves stay on one disk.
  const work = path.join(path.dirname(root), `.maxshell-update-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work);
  try {
    say('Downloading the newest maxshell…\n');
    const zip = path.join(work, 'maxshell.zip');
    let r = spawnSync('curl', ['-fsSL', url, '-o', zip], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { say('✗ download failed — nothing was changed\n'); return 1; }
    r = spawnSync('unzip', ['-q', zip, '-d', work], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { say('✗ couldn’t unzip it — nothing was changed\n'); return 1; }
    const fresh = fs.readdirSync(work).map((n) => path.join(work, n))
      .find((p) => fs.existsSync(path.join(p, 'bin', 'maxshell.js')));
    if (!fresh) { say('✗ the download doesn’t look like maxshell — nothing was changed\n'); return 1; }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const old = path.join(trashDir(), `${path.basename(root)} ${before} ${stamp}`);
    move(root, old);
    try { move(fresh, root); } catch (e) { move(old, root); throw e; }
    say(`✓ maxshell ${before} → ${version(root)}\n  (the old folder is in the Trash)\n`);
    return 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { update };
