'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Named command lines (snippets) and named folders (bookmarks), each kept
// in a small file of `name TAB value` lines.

function snippetsFile() {
  return process.env.MAXSHELL_SNIPPETS_FILE || path.join(os.homedir(), '.maxshell_snippets');
}

function marksFile() {
  return process.env.MAXSHELL_MARKS_FILE || path.join(os.homedir(), '.maxshell_marks');
}

class Store {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const tab = line.indexOf('\t');
        if (tab > 0) this.map.set(line.slice(0, tab), JSON.parse(line.slice(tab + 1)));
      }
    } catch { /* nothing saved yet */ }
  }

  save() {
    const body = [...this.map].map(([k, v]) => `${k}\t${JSON.stringify(v)}`).join('\n');
    fs.writeFileSync(this.file, body ? `${body}\n` : '');
  }

  set(name, value) { this.map.set(name, value); this.save(); }

  delete(name) { const had = this.map.delete(name); if (had) this.save(); return had; }

  rename(from, to) {
    if (!this.map.has(from)) return false;
    const v = this.map.get(from);
    this.map.delete(from);
    this.map.set(to, v);
    this.save();
    return true;
  }

  get(name) { return this.map.get(name); }

  entries() { return [...this.map]; }
}

// A short name for a command line: its first couple of words.
function suggestName(cmd) {
  return cmd.trim().split(/\s+/).slice(0, 2).join('-').replace(/[^\w.-]+/g, '').slice(0, 24) || 'snippet';
}

module.exports = { Store, snippetsFile, marksFile, suggestName };
