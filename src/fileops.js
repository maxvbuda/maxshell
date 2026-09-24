'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Finder-style file operations. Nothing here deletes: removals go to the
// Trash, and every operation returns a record that undo() can reverse.

function trashDir() {
  const dir = process.env.MAXSHELL_TRASH || (process.platform === 'darwin'
    ? path.join(os.homedir(), '.Trash')
    : path.join(os.homedir(), '.local', 'share', 'Trash', 'files'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function splitName(name, isDir) {
  const ext = path.extname(name);
  if (isDir || !ext || ext === name) return [name, ''];
  return [name.slice(0, -ext.length), ext];
}

// "name.txt", then "name 2.txt", "name 3.txt" ... — the first that is free.
function freeName(dir, stem, ext = '') {
  let name = `${stem}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem} ${n}${ext}`;
  return name;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Renames across devices by copying, like Finder does between volumes.
function relocate(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function newFolder(dir, name = 'untitled folder') {
  const target = path.join(dir, freeName(dir, name));
  fs.mkdirSync(target);
  return { type: 'create', path: target };
}

function newFile(dir, name = 'untitled.txt') {
  const [stem, ext] = splitName(name, false);
  const target = path.join(dir, freeName(dir, stem, ext));
  fs.writeFileSync(target, '', { flag: 'wx' });
  return { type: 'create', path: target };
}

function validName(name) {
  if (!name || name === '.' || name === '..') return 'a name is needed';
  if (name.includes('/')) return "names can't contain /";
  return null;
}

function rename(from, newName) {
  const problem = validName(newName);
  if (problem) throw new Error(problem);
  const to = path.join(path.dirname(from), newName);
  if (to === from) return null;
  // Allow a case-only rename on case-insensitive disks.
  if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) {
    throw new Error(`“${newName}” already exists`);
  }
  fs.renameSync(from, to);
  return { type: 'move', pairs: [{ from, to }] };
}

function duplicate(p) {
  const dir = path.dirname(p);
  const [stem, ext] = splitName(path.basename(p), isDir(p));
  const to = path.join(dir, freeName(dir, `${stem} copy`, ext));
  fs.cpSync(p, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return { type: 'copy', paths: [to] };
}

function insideOf(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Copies into `dir`. A name clash keeps both, as Finder's "Keep Both" does;
// copying into the same folder produces "name copy".
function copyInto(paths, dir) {
  const made = [];
  for (const p of paths) {
    if (isDir(p) && insideOf(dir, p)) throw new Error(`can't copy “${path.basename(p)}” into itself`);
    const [stem, ext] = splitName(path.basename(p), isDir(p));
    const sameFolder = path.dirname(p) === dir;
    const to = path.join(dir, freeName(dir, sameFolder ? `${stem} copy` : stem, ext));
    fs.cpSync(p, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    made.push(to);
  }
  return { type: 'copy', paths: made };
}

function moveInto(paths, dir) {
  const pairs = [];
  for (const p of paths) {
    if (path.dirname(p) === dir) continue;
    if (isDir(p) && insideOf(dir, p)) throw new Error(`can't move “${path.basename(p)}” into itself`);
    const [stem, ext] = splitName(path.basename(p), isDir(p));
    const to = path.join(dir, freeName(dir, stem, ext));
    relocate(p, to);
    pairs.push({ from: p, to });
  }
  return pairs.length ? { type: 'move', pairs } : null;
}

function trash(paths) {
  const bin = trashDir();
  const pairs = [];
  for (const p of paths) {
    const [stem, ext] = splitName(path.basename(p), isDir(p));
    const to = path.join(bin, freeName(bin, stem, ext));
    relocate(p, to);
    pairs.push({ from: p, to });
  }
  return { type: 'trash', pairs };
}

// Reverses an operation record. Creations and copies are undone by moving
// what was made to the Trash, never by deleting it.
function undo(record) {
  if (!record) return null;
  switch (record.type) {
    case 'move':
    case 'trash':
      for (const { from, to } of [...record.pairs].reverse()) {
        if (fs.existsSync(from)) throw new Error(`can't put back: “${path.basename(from)}” exists again`);
        relocate(to, from);
      }
      return record.pairs.map((pr) => pr.from);
    case 'create':
      trash([record.path]);
      return [];
    case 'copy':
      trash(record.paths.filter((p) => fs.existsSync(p)));
      return [];
    default:
      return null;
  }
}

// Size of a file or a folder's contents, capped so huge trees stay fast.
function sizeOf(p, cap = 50000) {
  let bytes = 0;
  let items = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(cur); } catch { /* unreadable */ }
      for (const n of names) stack.push(path.join(cur, n));
      if (cur !== p) items++;
    } else {
      bytes += st.size;
      if (cur !== p) items++;
    }
    if (items >= cap) return { bytes, items, partial: true };
  }
  return { bytes, items, partial: false };
}

// Walks `root` for names containing `query` — Finder's search, by name.
function search(root, query, { showHidden = false, limit = 400, maxEntries = 60000 } = {}) {
  const needle = query.toLowerCase();
  const results = [];
  const queue = [root];
  let seen = 0;
  const SKIP = new Set(['node_modules', '.git', 'Library', '.Trash']);
  while (queue.length && results.length < limit && seen < maxEntries) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      seen++;
      if (!showHidden && d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (d.name.toLowerCase().includes(needle)) results.push(full);
      if (d.isDirectory() && !SKIP.has(d.name)) queue.push(full);
      if (results.length >= limit) break;
    }
  }
  return { results, truncated: results.length >= limit || seen >= maxEntries };
}

module.exports = {
  trashDir, freeName, splitName, newFolder, newFile, rename, duplicate,
  copyInto, moveInto, trash, undo, sizeOf, search, validName, insideOf,
};
