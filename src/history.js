'use strict';

const fs = require('fs');
const path = require('path');

// Command history with the folder and time of every command, so search can
// favour what you ran here, recently, and often. The file stays one command
// per line; old plain-text lines still load.
//
//   <ms since epoch> TAB <cwd> TAB <command>

class History {
  constructor() {
    this.entries = [];
  }

  static parse(line) {
    const m = /^(\d{12,})\t([^\t]*)\t(.*)$/.exec(line);
    if (m) return { ts: Number(m[1]), cwd: m[2] || null, cmd: m[3] };
    return { ts: 0, cwd: null, cmd: line };
  }

  load(file, limit = 5000) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      this.entries = lines.slice(-limit).map(History.parse).filter((e) => e.cmd.trim());
    } catch {
      this.entries = [];
    }
    return this;
  }

  save(file, limit = 5000) {
    // Entries with no time or folder (from old plain files) stay plain.
    const body = this.entries.slice(-limit)
      .map((e) => (e.ts || e.cwd ? `${e.ts || 0}\t${e.cwd || ''}\t${e.cmd}` : e.cmd)).join('\n');
    fs.writeFileSync(file, `${body}\n`);
  }

  add(cmd, cwd, ts = Date.now()) {
    const text = cmd.replace(/\n/g, '; ').trim();
    if (!text) return false;
    const last = this.entries[this.entries.length - 1];
    if (last && last.cmd === text && last.cwd === cwd) { last.ts = ts; return false; }
    this.entries.push({ cmd: text, cwd, ts });
    return true;
  }

  commands() { return this.entries.map((e) => e.cmd); }

  // One row per distinct command: how often, how recently, and whether it
  // was ever run in `cwd`.
  distinct(cwd) {
    const byCmd = new Map();
    for (const e of this.entries) {
      let d = byCmd.get(e.cmd);
      if (!d) { d = { cmd: e.cmd, count: 0, lastTs: 0, lastCwd: null, here: false }; byCmd.set(e.cmd, d); }
      d.count++;
      if (e.ts >= d.lastTs) { d.lastTs = e.ts; d.lastCwd = e.cwd; }
      if (cwd && e.cwd === cwd) d.here = true;
    }
    return [...byCmd.values()];
  }

  // Fuzzy search: every word of the query must appear, in any order. Ranked
  // by match quality, then this folder, recency and frequency.
  search(query, { cwd = null, now = Date.now(), limit = 200 } = {}) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [];
    for (const d of this.distinct(cwd)) {
      const m = fuzzyMatch(d.cmd, tokens);
      if (!m) continue;
      const ageDays = d.lastTs ? (now - d.lastTs) / 86400000 : 365;
      const score = m.score
        + (d.here ? 6 : 0)
        + 8 * Math.exp(-ageDays / 3)
        + 2 * Math.log2(d.count + 1);
      rows.push({ ...d, score, positions: m.positions });
    }
    rows.sort((a, b) => (tokens.length ? b.score - a.score : 0) || b.lastTs - a.lastTs);
    return rows.slice(0, limit);
  }
}

// Matches each token as a substring, or failing that as a subsequence (so
// "gpo" finds "git push origin"). Returns a score and the matched positions.
function fuzzyMatch(text, tokens) {
  const hay = text.toLowerCase();
  const positions = new Set();
  let score = 0;
  for (const tok of tokens) {
    const at = hay.indexOf(tok);
    if (at !== -1) {
      const wordStart = at === 0 || /[\s/._-]/.test(hay[at - 1]);
      score += 10 + (wordStart ? 5 : 0) + tok.length;
      for (let i = 0; i < tok.length; i++) positions.add(at + i);
      continue;
    }
    let j = 0;
    const found = [];
    for (let i = 0; i < hay.length && j < tok.length; i++) {
      if (hay[i] === tok[j]) { found.push(i); j++; }
    }
    if (j < tok.length) return null;
    const spread = found[found.length - 1] - found[0];
    score += Math.max(1, 6 - spread / 4);
    for (const i of found) positions.add(i);
  }
  return { score, positions };
}

// "just now", "5m ago", "2h ago", "3d ago", "6w ago"
function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (86400 * 7))}w ago`;
}

function historyFile() {
  return process.env.MAXSHELL_HISTORY_FILE
    || path.join(require('os').homedir(), '.maxshell_history');
}

module.exports = { History, fuzzyMatch, ago, historyFile };
