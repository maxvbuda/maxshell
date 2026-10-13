#!/usr/bin/env node
'use strict';

// The bridge between Sage for Mac (mac/, a SwiftUI app) and Sage itself.
// It runs a SageApp — the same state as `sage` in the terminal: the engine,
// Sage Code's tools (asked first, replaced files to the Trash), drawing and
// filming — without a screen. The Mac app sends actions as JSON lines on
// stdin and gets the app's state back as JSON lines on stdout:
//
//   in:  {op: 'open', mode, root, model?, id, items?}   chat | code | image
//        | video; shows that conversation — a live one as it is, else a new
//        one, or with items an earlier one, which Sage remembers
//        {op: 'submit', text}  {op: 'answer', choice: y|a|n}  {op: 'stop'}
//        {op: 'model', key}  {op: 'think', level}  {op: 'new'}
//        {op: 'load', file} (image: a picture of yours)  {op: 'quit'}
//   out: {ev: 'state', id, mode, root, model, models, status, speed,
//         thinking, thinks, waiting, drawing, suggestion, queued, working,
//         asking, items}   (the conversation shown; working / asking: the ids
//         of every conversation still at it / waiting for your OK)
//        {ev: 'error', text}

const fs = require('fs');
const path = require('path');
const sage = require('./sage');
const gemma = require('./gemma');
const img = require('./sageimage');
const video = require('./sagevideo');
const { texToText, texLines } = require('./tex');

const shellFor = (root) => ({ cwd: root, env: { ...process.env, MAXSHELL_IMAGE_NO_OPEN: '1' } });
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// Math as Unicode, the way the terminal shows it: $…$ and \(…\) inline,
// $$…$$ and \[…\] on lines of their own. Code is left alone.
function math(text) {
  return String(text).split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => {
    if (i % 2) return part;
    return part
      .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => `\n\n${texLines((a || b).trim()).map((l) => `    ${l}`).join('\n')}\n\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => texToText(t))
      .replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, pre, t) => pre + texToText(t));
  }).join('');
}

// The transcript, ready to show: no jobs, caches or functions.
function itemsOf(app) {
  return app.items.map((it) => {
    const o = {};
    for (const [k, v] of Object.entries(it)) {
      if (['job', 'cache', 'cacheKey', 'options', 'where', 'v'].includes(k) || typeof v === 'function') continue;
      o[k] = v;
    }
    if (it.type === 'sage') o.text = math(it.text);
    if (it.type === 'tool' && app.approval && app.approval.item === it) o.asking = true;
    return o;
  });
}

function models(mode) {
  const keys = ['ultra', 'e4b', 'e2b', 'lite'];
  return keys.map((key) => {
    const info = sage.modelInfo(mode, key);
    return { key, label: info.label, blurb: info.blurb, flag: info.flag, ready: gemma.ready(gemma.modelFor(key, mode)), thinks: !!info.thinks };
  });
}

// --- engines: one per model (and mode and folder), shared by conversations --
//
// Each conversation is a SageApp of its own, and they all stay alive: one
// can carry on — answering, waiting for your OK, drawing — while the Mac app
// shows another. Conversations on the same model share its engine (sage.py
// keeps a memory for each, by "conv", and answers one at a time).

const engines = new Map(); // key → { key, engine, views, queue (convs with a question in), ready }

function sharedEngine(key, argv, opts) {
  let s = engines.get(key);
  if (s && !s.dead) return s;
  // Loading another model: let go of the idle ones (each is GBs of memory);
  // their conversations start them again when you come back.
  for (const other of engines.values()) {
    if (!working(other)) retire(other);
  }
  s = { key, engine: new sage.Engine(argv, opts), views: new Map(), queue: [], ready: null, dead: false, used: Date.now() };
  engines.set(key, s);
  return s;
}

// A model nobody has used for a while is let go too: it holds GBs (Ultra
// 16) while the app sits in the background. The next message starts it
// again with the conversation (a few seconds; Ultra about 15).
const IDLE_MS = (Number(process.env.MAXSHELL_SAGE_IDLE) || 600) * 1000;
const working = (s) => s.queue.length > 0 || [...s.views.values()].some((v) => v.app && (v.app.approval || v.app.busy));
function retireIdle() {
  for (const s of [...engines.values()]) if (!working(s) && Date.now() - s.used > IDLE_MS) retire(s);
}

function retire(s) {
  s.dead = true;
  engines.delete(s.key);
  for (const v of s.views.values()) v.closed = true;
  s.engine.close();
}

// What one conversation's SageApp sees as its engine.
function view(s, conv) {
  const v = {
    events: s.ready ? [{ ev: 'ready', device: s.ready }] : [], // a loaded engine is ready at once
    closed: false,
    app: null,
    send(cmd) {
      if (v.closed) return;
      if (cmd.op === 'ask') s.queue.push(conv);
      s.used = Date.now();
      s.engine.send({ ...cmd, conv });
    },
    poll() { const e = v.events; v.events = []; return e; },
    // Stops its own answer; a question still waiting its turn is taken back.
    interrupt() {
      if (s.queue[0] === conv) s.engine.interrupt();
      else if (s.queue.includes(conv)) s.engine.send({ op: 'cancel', conv });
    },
    errors: () => s.engine.errors(),
    close() {
      if (v.closed) return;
      v.closed = true;
      if (s.queue[0] === conv) s.engine.interrupt();
      s.views.delete(conv);
      s.engine.send({ op: 'drop', conv });
      if (!s.views.size && !s.dead) retire(s);
    },
    get waitingTurn() { return s.queue.includes(conv) && s.queue[0] !== conv; },
  };
  s.views.set(conv, v);
  return v;
}

// Engine events to the conversations they're about.
function pump() {
  for (const s of [...engines.values()]) {
    for (const ev of s.engine.poll()) {
      s.used = Date.now();
      if (ev.ev === 'ready' && (!ev.conv || ev.conv === 'main')) s.ready = ev.device || 'gpu'; // the engine's own, not a conversation's
      if (ev.ev === 'done') { const i = s.queue.indexOf(ev.conv); if (i >= 0) s.queue.splice(i, 1); }
      if (ev.ev === 'exit') { s.dead = true; engines.delete(s.key); }
      if (ev.conv && ev.conv !== 'main') { const v = s.views.get(ev.conv); if (v) v.events.push(ev); } else for (const v of s.views.values()) v.events.push(ev);
    }
  }
}

// --- conversations ---------------------------------------------------------------

const apps = new Map(); // conversation id → its SageApp, the most recently shown last
let currentId = null;
const current = () => apps.get(currentId) || null;
const MAX_APPS = 8;

function makeApp({ id, mode, root, model, items }) {
  const shell = shellFor(root);
  const writer = () => gemma.promptWriter(shell);
  const free = () => gemma.freeMemory();
  const conv = { id, items: items || [] };
  if (mode === 'image' || mode === 'video') {
    return new sage.SageApp({
      mode, root, model: 'e4b', models: [], start: () => sage.IDLE, resume: conv,
      startImage: mode === 'image' && img.ready() ? (o) => new img.Job(o, root, { env: shell.env, free: free(), writer: o.exact ? null : writer() }) : null,
      startVideo: mode === 'video' && video.ready() ? (o) => video.job(o, root, { env: shell.env, free: free(), writer: o.exact ? null : writer() }) : null,
    });
  }
  const list = models(mode);
  let key = model && list.some((m) => m.key === model) ? model : gemma.pick([]).key;
  const auto = gemma.fallback(key, !!model);
  key = auto.key;
  const base = process.env.MAXSHELL_GEMMA || path.join(process.env.HOME, '.maxshell', 'gemma');
  const fake = process.env.MAXSHELL_SAGE_ENGINE; // tests: a stand-in for sage.py
  let app = null;
  const start = (k, md) => {
    const m = gemma.modelFor(k, md);
    const s = sharedEngine(`${k}|${md}|${md === 'code' ? root : ''}`,
      fake ? [process.execPath, fake, '{commands}', md]
        : [process.env.MAXSHELL_GEMMA_PYTHON || path.join(base, 'venv', 'bin', 'python'), path.join(__dirname, 'sage.py'), '--serve', '{commands}', md],
      { cwd: root, env: { ...shell.env, MAXSHELL_GEMMA: path.join(base, m.sub), MAXSHELL_SAGE_NAME: m.name, MAXSHELL_NODE: process.execPath } });
    const v = view(s, id);
    v.app = app;
    return v;
  };
  const startImage = img.ready() ? (o) => new img.Job(o, root, { env: shell.env, free: free() }) : null;
  app = new sage.SageApp({ mode, root, model: key, models: list.map((m) => ({ key: m.key, ready: m.ready })), start, notice: auto.why, startImage, resume: conv });
  app.engine.app = app;
  const info = list.find((m) => m.key === key);
  if (!info.ready) {
    app.status = 'error';
    app.note(`${info.label} isn’t set up — in a terminal, run: sage${mode === 'code' ? ' code' : ''} --${info.flag} --setup`, 'err');
  }
  if (auto.why) app.note(auto.why);
  return app;
}

function open({ mode = 'chat', root = process.env.HOME, model, id, items } = {}) {
  root = path.resolve(root || process.env.HOME);
  id = id || require('./conversations').newId();
  let app = apps.get(id);
  if (app) {
    apps.delete(id); // most recent last
    // its engine was let go while it was idle: start it again, with the conversation
    if (!app.media && app.engine.closed) { app.useModel(app.model); app.remember(); }
  } else {
    app = makeApp({ id, mode, root, model, items });
  }
  apps.set(id, app);
  currentId = id;
  // Keep a few: let go of the oldest idle ones (they're kept on disk and come back).
  for (const [oid, a] of apps) {
    if (apps.size <= MAX_APPS) break;
    if (oid === id || a.busy || a.approval || a.drawing()) continue;
    saveAll(true);
    a.close();
    apps.delete(oid);
    kept.delete(oid);
  }
}

function act(cmd) {
  if (cmd.op === 'quit') { saveAll(true); for (const a of apps.values()) a.close(); process.exit(0); }
  if (cmd.op === 'open') { open(cmd); return; }
  if (cmd.op === 'close') { // a conversation moved to the Trash: stop it, keep it no longer
    const a = apps.get(cmd.id);
    if (a) { a.close(); apps.delete(cmd.id); kept.delete(cmd.id); }
    return;
  }
  const app = current();
  if (!app) return;
  switch (cmd.op) {
    case 'submit':
      if (!app.media && app.engine.closed) { app.useModel(app.model); app.engine.app = app; app.remember(); } // its model was let go while idle
      app.setInput(String(cmd.text || '')); app.submit(); break;
    case 'answer': app.answer(cmd.choice); break;
    case 'stop': if (app.busy || app.approval || app.drawing()) app.interrupt(); break;
    case 'model': app.switchModel(cmd.key); app.engine.app = app; break;
    case 'think': app.setThinking(cmd.level); break;
    case 'new': app.newChat(); break;
    case 'load': app.load(cmd.file); break;
    default: break;
  }
}

// --- every conversation is kept as it goes (src/conversations.js) ----------------

const conversations = require('./conversations');
const kept = new Map(); // id → the version saved
let keptAt = 0;
function saveAll(now) {
  if (!now && Date.now() - keptAt < 1500) return;
  keptAt = Date.now();
  for (const [id, a] of apps) {
    if (kept.get(id) === a.version) continue;
    kept.set(id, a.version);
    try { conversations.save({ id, mode: a.mode, root: a.root, model: a.model, items: a.items }); } catch { /* next time */ }
  }
}

// --- the loop: actions in, engines and jobs polled, state out ---------------------

let lastSent = '';
let lastAt = 0;
function publish(force) {
  const app = current();
  if (!app) return;
  const now = Date.now();
  if (!force && now - lastAt < 50) return; // at most 20 a second
  const ids = (f) => [...apps].filter(([, a]) => f(a)).map(([id]) => id);
  const state = {
    ev: 'state', id: currentId, mode: app.mode, root: app.root, model: app.model, models: app.media ? [] : models(app.mode),
    status: app.status, speed: app.speed || 0, thinking: app.thinking, thinks: app.thinks,
    waiting: !!app.approval, drawing: !!app.drawing(), suggestion: app.suggestion || null,
    queued: !!(app.engine && app.engine.waitingTurn), // its question waits for another conversation's answer
    working: ids((a) => a.busy || !!a.drawing()), asking: ids((a) => !!a.approval), // every conversation still at it
    items: itemsOf(app),
  };
  const s = JSON.stringify(state);
  if (s === lastSent) return;
  lastSent = s;
  lastAt = now;
  process.stdout.write(`${s}\n`);
}

function main() {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let cmd;
      try { cmd = JSON.parse(line); } catch { continue; }
      try { act(cmd); } catch (e) { send({ ev: 'error', text: e.message }); }
      publish(true);
    }
  });
  const quit = () => { saveAll(true); for (const a of apps.values()) a.close(); process.exit(0); };
  process.stdin.on('end', quit);
  process.on('SIGTERM', quit);

  setInterval(() => {
    try {
      pump();
      retireIdle();
      for (const app of apps.values()) { // every conversation keeps going, shown or not
        for (const ev of app.engine.poll()) app.onEvent(ev);
        app.tick();
        if (app.toRun) { publish(true); app.work(); }
      }
      saveAll(false);
    } catch (e) { send({ ev: 'error', text: e.message }); }
    publish(false);
  }, 40);
}

if (require.main === module) main();

module.exports = { math, itemsOf, models };
