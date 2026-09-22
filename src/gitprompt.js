'use strict';

const { spawnSync } = require('child_process');

const cache = new Map();
const TTL_MS = 1500;

// Summarises the git repo at `cwd`, or null if there isn't one. Results are
// cached briefly so redrawing the prompt on every keystroke stays cheap.
function gitInfo(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;
  let res;
  try {
    res = spawnSync('git', ['status', '--porcelain=2', '--branch'], {
      cwd,
      encoding: 'utf8',
      timeout: 400,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    res = null;
  }

  if (res && !res.error && res.status === 0 && res.stdout) {
    let branch = null;
    let ahead = 0;
    let behind = 0;
    let dirty = false;
    let staged = false;
    let untracked = false;

    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim();
        branch = head === '(detached)' ? 'HEAD' : head;
      } else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const xy = line.slice(2, 4);
        if (xy[0] !== '.') staged = true;
        if (xy[1] !== '.') dirty = true;
      } else if (line.startsWith('u ')) {
        dirty = true;
      } else if (line.startsWith('? ')) {
        untracked = true;
      }
    }
    if (branch) value = { branch, ahead, behind, dirty, staged, untracked };
  }

  cache.set(cwd, { at: Date.now(), value });
  return value;
}

function clearCache() { cache.clear(); }

module.exports = { gitInfo, clearCache };
