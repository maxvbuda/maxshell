'use strict';

// Sage Code's tools, run by the app (src/sage.js) when Gemma calls them:
// list_files, read_file and search_files look; write_file and edit_file
// change, and are shown to the user as a diff and asked first. A file that's
// replaced or edited goes to the Trash before the new text is written
// (fileops.js), so nothing is lost. Each tool returns { text } — what Gemma
// is told — and the app's summary, { title, detail }.

const fs = require('fs');
const path = require('path');
const fileops = require('./fileops');

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.venv', 'venv', 'dist', 'build']);
const MAX_READ = 60000;     // characters of a file Gemma gets
const MAX_LIST = 300;
const MAX_HITS = 80;
const READS = new Set(['list_files', 'read_file', 'search_files']);
const CHANGES = new Set(['write_file', 'edit_file']);

const home = () => process.env.HOME || '';
// A path as the user would write it: relative to the project, or ~/….
function pretty(full, root) {
  const rel = path.relative(root, full);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return home() && full.startsWith(home() + path.sep) ? `~${full.slice(home().length)}` : full;
}

function resolve(p, root) {
  let s = String(p || '.').trim() || '.';
  if (s === '~' || s.startsWith('~/')) s = path.join(home(), s.slice(1));
  return path.resolve(root, s);
}

const inside = (full, root) => full === root || full.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const isText = (buf) => !buf.subarray(0, 8000).includes(0);
const lines = (s) => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function listFiles(args, root) {
  const dir = resolve(args.path, root);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { text: `Can't list ${pretty(dir, root)}: ${e.code || e.message}`, title: `List ${pretty(dir, root)}`, detail: 'failed' }; }
  const names = entries.filter((e) => !SKIP.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b));
  const shown = names.slice(0, MAX_LIST);
  const more = names.length > shown.length ? `\n… and ${names.length - shown.length} more` : '';
  return { text: shown.length ? shown.join('\n') + more : '(empty folder)', title: `List ${pretty(dir, root)}`, detail: `${names.length} entr${names.length === 1 ? 'y' : 'ies'}` };
}

function readFile(args, root) {
  const full = resolve(args.path, root);
  const title = `Read ${pretty(full, root)}`;
  let buf;
  try { buf = fs.readFileSync(full); } catch (e) { return { text: `Can't read ${pretty(full, root)}: ${e.code === 'EISDIR' ? 'it is a folder' : e.code || e.message}`, title, detail: 'failed' }; }
  if (!isText(buf)) return { text: `${pretty(full, root)} isn't a text file.`, title, detail: 'not text' };
  const s = buf.toString('utf8');
  const cut = s.length > MAX_READ ? `${s.slice(0, MAX_READ)}\n… (cut: the file is ${s.length} characters)` : s;
  return { text: cut, title, detail: plural(lines(s), 'line') };
}

function searchFiles(args, root) {
  const dir = resolve(args.path, root);
  const needle = String(args.text || '');
  const title = `Search for “${needle}”${args.path && args.path !== '.' ? ` in ${pretty(dir, root)}` : ''}`;
  if (!needle) return { text: 'Give some text to search for.', title, detail: 'failed' };
  const hits = [];
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= MAX_HITS || files > 5000) return;
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      files++;
      let buf;
      try { if (fs.statSync(full).size > 2e6) continue; buf = fs.readFileSync(full); } catch { continue; }
      if (!isText(buf)) continue;
      buf.toString('utf8').split('\n').forEach((line, i) => {
        if (hits.length < MAX_HITS && line.includes(needle)) hits.push(`${pretty(full, root)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
  };
  walk(dir);
  return { text: hits.length ? hits.join('\n') : 'No matches.', title, detail: `${hits.length}${hits.length >= MAX_HITS ? '+' : ''} match${hits.length === 1 ? '' : 'es'}` };
}

// --- changes ------------------------------------------------------------------

// What a change would do, worked out before asking: { full, before, after }
// or { error }.
function plan(name, args, root) {
  const full = resolve(args.path, root);
  const where = pretty(full, root);
  if (!String(args.path || '').trim()) return { error: 'No path was given.' };
  let before = null;
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) return { error: `${where} is a folder.` };
    const buf = fs.readFileSync(full);
    if (!isText(buf)) return { error: `${where} isn't a text file.` };
    before = buf.toString('utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return { error: `Can't read ${where}: ${e.code || e.message}` };
  }
  if (name === 'write_file') {
    let after = String(args.content ?? '');
    if (after && !after.endsWith('\n')) after += '\n';
    if (before === after) return { error: `${where} already has exactly that text.` };
    return { full, where, before, after };
  }
  // edit_file
  if (before === null) return { error: `${where} doesn't exist. Use write_file to create it.` };
  const oldText = String(args.old_text ?? '');
  const newText = String(args.new_text ?? '');
  if (!oldText) return { error: 'old_text is empty: copy the exact text to change from the file.' };
  const at = before.indexOf(oldText);
  if (at < 0) return { error: `old_text isn't in ${where}. Read the file and copy the text exactly, including spaces.` };
  if (before.indexOf(oldText, at + 1) >= 0) return { error: `old_text is in ${where} more than once. Include more of the surrounding lines so it's found once.` };
  if (oldText === newText) return { error: 'old_text and new_text are the same.' };
  return { full, where, before, after: before.slice(0, at) + newText + before.slice(at + oldText.length) };
}

// Writes a planned change; the file that was there goes to the Trash.
function apply(p) {
  try {
    if (p.before !== null) fileops.trash([p.full]);
    fs.mkdirSync(path.dirname(p.full), { recursive: true });
    fs.writeFileSync(p.full, p.after);
  } catch (e) {
    return { ok: false, text: `Couldn't save ${p.where}: ${e.code || e.message}` };
  }
  const n = plural(lines(p.after), 'line');
  return { ok: true, text: p.before === null ? `Created ${p.where} (${n}).` : `Saved ${p.where} (${n}); the old version is in the Trash.` };
}

// --- diff ---------------------------------------------------------------------

// A line diff with `context` lines around each change: rows of
// { kind: ' ' | '+' | '-' | '…', text, a, b } (a/b: old/new line numbers).
function diff(before, after, context = 3) {
  const A = before === null || before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const B = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  // Trim the common start and end, then LCS on what's left (capped).
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a = A.slice(s, A.length - e);
  const b = B.slice(s, B.length - e);
  let mid;
  if (a.length * b.length > 4e6) {
    mid = [...a.map((t) => ['-', t]), ...b.map((t) => ['+', t])];
  } else {
    const n = a.length;
    const m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { mid.push([' ', a[i]]); i++; j++; } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { mid.push(['-', a[i]]); i++; } else { mid.push(['+', b[j]]); j++; }
    }
  }
  const all = [...A.slice(0, s).map((t) => [' ', t]), ...mid, ...A.slice(A.length - e).map((t) => [' ', t])];
  let ai = 0;
  let bi = 0;
  const rows = all.map(([kind, text]) => {
    const row = { kind, text, a: kind === '+' ? null : ++ai, b: kind === '-' ? null : ++bi };
    return row;
  });
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.kind === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  rows.forEach((r, i) => {
    if (keep[i]) out.push(r);
    else if (out.length && out[out.length - 1].kind !== '…') out.push({ kind: '…', text: '' });
  });
  if (out.length && out[0].kind === '…') out.shift();
  if (out.length && out[out.length - 1].kind === '…') out.pop();
  const added = rows.filter((r) => r.kind === '+').length;
  const removed = rows.filter((r) => r.kind === '-').length;
  return { rows: out, added, removed };
}

// Runs a look-only tool: { text, title, detail }.
function look(name, args, root) {
  if (name === 'list_files') return listFiles(args, root);
  if (name === 'read_file') return readFile(args, root);
  if (name === 'search_files') return searchFiles(args, root);
  return { text: `There is no tool called ${name}.`, title: name, detail: 'unknown' };
}

// Whether a look needs asking: only outside the project folder.
function needsAsk(name, args, root) {
  if (CHANGES.has(name)) return true;
  return !inside(resolve(args.path, root), root);
}

module.exports = { plural, look, plan, apply, diff, needsAsk, pretty, resolve, READS, CHANGES };
