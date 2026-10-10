'use strict';

// Sage's conversations, kept so Sage remembers them: one JSON file each in
// ~/Library/Application Support/Sage/Conversations — shared by `sage` in the
// terminal and Sage for Mac (mac/), which list and continue the same ones.
// { id, mode, root, title, updated, model, items } — items as SageApp's.
// MAXSHELL_SAGE_HISTORY points somewhere else (tests).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = () => process.env.MAXSHELL_SAGE_HISTORY || path.join(os.homedir(), 'Library', 'Application Support', 'Sage', 'Conversations');
const newId = () => crypto.randomUUID().toUpperCase(); // as Swift's UUID writes it
const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z'); // ISO 8601 without fractions, for Swift

// What's worth keeping of the transcript: no jobs, caches or functions.
function plain(items) {
  return items.map((it) => {
    const o = {};
    for (const [k, v] of Object.entries(it)) {
      if (['job', 'cache', 'cacheKey', 'options', 'where', 'v', 'hits'].includes(k) || typeof v === 'function') continue;
      o[k] = v;
    }
    if ((o.type === 'image' || o.type === 'video') && o.state === 'running') o.state = 'stopped';
    if (o.type === 'tool' && o.state === 'ask') o.state = 'declined';
    if (o.type === 'thought' || o.type === 'sage') o.done = true;
    return o;
  });
}

function title(items) {
  const first = items.find((i) => i.type === 'user');
  return first ? String(first.text).split('\n')[0].slice(0, 80) : null;
}

function save(c) {
  const t = title(c.items);
  if (!t) return false; // nothing said yet
  fs.mkdirSync(dir(), { recursive: true });
  const conv = { id: c.id, mode: c.mode, root: c.root, title: t, updated: stamp(), model: c.model, items: plain(c.items) };
  const file = path.join(dir(), `${c.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(conv));
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

function list() {
  let names;
  try { names = fs.readdirSync(dir()); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8'))); } catch { /* half written */ }
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

// The latest conversation in a mode (sage code: in this folder), but not `not`.
function latest(mode, root = null, not = null) {
  return list().find((c) => c.mode === mode && c.id !== not && (!root || path.resolve(c.root) === path.resolve(root))) || null;
}

// What the engine needs to remember a conversation: [[question, answer], …],
// the answer with what Sage did meanwhile (its tools) noted in it.
function turns(items) {
  const out = [];
  let cur = null;
  for (const it of items) {
    if (it.type === 'user') { cur = [String(it.text), '']; out.push(cur); continue; }
    if (!cur) continue;
    if (it.type === 'sage' && String(it.text || '').trim()) cur[1] += `${cur[1] ? '\n\n' : ''}${String(it.text).trim()}`;
    else if (it.type === 'tool') cur[1] += `${cur[1] ? '\n' : ''}[${it.title}${it.detail ? ` — ${it.detail}` : ''}${it.state === 'declined' ? ' — the user said no' : it.state === 'fail' ? ' — failed' : ''}]`;
    else if ((it.type === 'image' || it.type === 'video') && it.state === 'done') cur[1] += `${cur[1] ? '\n' : ''}[made ${it.out}]`;
  }
  return out.filter(([q]) => q.trim());
}

module.exports = { dir, newId, stamp, plain, title, save, list, latest, turns };
