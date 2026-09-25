'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Frecency-ranked folders for `j`: each visit raises a folder's rank, and
// recent visits count for more — the scheme zoxide popularised.

function dbFile() {
  return process.env.MAXSHELL_DIRS_FILE || path.join(os.homedir(), '.maxshell_dirs');
}

const MAX_TOTAL = 10000;

class DirDB {
  constructor(file = dbFile()) {
    this.file = file;
    this.dirs = new Map();
    this.load();
  }

  load() {
    this.dirs.clear();
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      const [p, rank, last] = line.split('\t');
      if (p && Number(rank) > 0) this.dirs.set(p, { rank: Number(rank), last: Number(last) || 0 });
    }
  }

  save() {
    const body = [...this.dirs].map(([p, e]) => `${p}\t${e.rank.toFixed(2)}\t${e.last}`).join('\n');
    try { fs.writeFileSync(this.file, `${body}\n`); } catch { /* best effort */ }
  }

  visit(dir, now = Date.now()) {
    if (!dir || dir === os.homedir() || dir === '/') return;
    const e = this.dirs.get(dir) || { rank: 0, last: 0 };
    e.rank += 1;
    e.last = now;
    this.dirs.set(dir, e);
    // Age everything once the total grows, forgetting folders rarely used.
    const total = [...this.dirs.values()].reduce((s, x) => s + x.rank, 0);
    if (total > MAX_TOTAL) {
      for (const [p, x] of this.dirs) {
        x.rank *= 0.9;
        if (x.rank < 1) this.dirs.delete(p);
      }
    }
  }

  static score(e, now = Date.now()) {
    const hours = (now - e.last) / 3600000;
    const weight = hours < 1 ? 4 : hours < 24 ? 2 : hours < 24 * 7 ? 0.5 : 0.25;
    return e.rank * weight;
  }

  // Folders whose path contains every word in order, the last word within
  // the final path component. Missing folders are dropped as found.
  query(words, { cwd = null, now = Date.now(), exists = fs.existsSync } = {}) {
    const terms = words.map((w) => w.toLowerCase()).filter(Boolean);
    const hits = [];
    for (const [p, e] of this.dirs) {
      if (!pathMatches(p, terms)) continue;
      if (!exists(p)) { this.dirs.delete(p); continue; }
      hits.push({ path: p, score: DirDB.score(e, now) });
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    // Don't "jump" to where you already are unless it is the only match.
    if (cwd && hits.length > 1 && hits[0].path === cwd) hits.push(hits.shift());
    return hits;
  }
}

function pathMatches(p, terms) {
  const hay = p.toLowerCase();
  let from = 0;
  for (const t of terms) {
    const at = hay.indexOf(t, from);
    if (at === -1) return false;
    from = at + t.length;
  }
  if (!terms.length) return true;
  const last = terms[terms.length - 1];
  return path.basename(hay).includes(last);
}

module.exports = { DirDB, dbFile, pathMatches };
