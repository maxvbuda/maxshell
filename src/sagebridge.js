#!/usr/bin/env node
'use strict';

// The bridge between Sage for Mac (mac/, a SwiftUI app) and Sage itself.
// It runs a SageApp — the same state as `sage` in the terminal: the engine,
// Sage Code's tools (asked first, replaced files to the Trash), drawing and
// filming — without a screen. The Mac app sends actions as JSON lines on
// stdin and gets the app's state back as JSON lines on stdout:
//
//   in:  {op: 'open', mode, root, model?, id?, items?}   chat | code | image
//        | video; with items, an earlier conversation, which Sage remembers
//        {op: 'submit', text}  {op: 'answer', choice: y|a|n}  {op: 'stop'}
//        {op: 'model', key}  {op: 'think', level}  {op: 'new'}
//        {op: 'load', file} (image: a picture of yours)  {op: 'quit'}
//   out: {ev: 'state', mode, root, model, models, status, speed, thinking,
//         thinks, waiting, drawing, items}   (items: the transcript)
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

let app = null;

function open({ mode = 'chat', root = process.env.HOME, model, id, items } = {}) {
  root = path.resolve(root || process.env.HOME);
  const conv = id ? { id, items: items || [] } : null;
  // The same model, idle: keep it loaded and just change the conversation.
  if (app && !app.media && app.mode === mode && app.root === root && (!model || model === app.model) && app.status === 'ready' && !app.drawing()) {
    if (app.approval) app.answer('n');
    app.newChat();
    if (conv) app.resume(conv);
    return;
  }
  if (app) app.close();
  const shell = shellFor(root);
  const writer = () => gemma.promptWriter(shell);
  const free = () => gemma.freeMemory();
  if (mode === 'image' || mode === 'video') {
    app = new sage.SageApp({
      mode, root, model: 'e4b', models: [], start: () => sage.IDLE, resume: conv,
      startImage: mode === 'image' && img.ready() ? (o) => new img.Job(o, root, { env: shell.env, free: free(), writer: o.exact ? null : writer() }) : null,
      startVideo: mode === 'video' && video.ready() ? (o) => video.job(o, root, { env: shell.env, free: free(), writer: o.exact ? null : writer() }) : null,
    });
  } else {
    const list = models(mode);
    let key = model && list.some((m) => m.key === model) ? model : gemma.pick([]).key;
    const auto = gemma.fallback(key, !!model);
    key = auto.key;
    const base = process.env.MAXSHELL_GEMMA || path.join(process.env.HOME, '.maxshell', 'gemma');
    const fake = process.env.MAXSHELL_SAGE_ENGINE; // tests: a stand-in for sage.py
    const start = (k, md) => new sage.Engine(
      fake ? [process.execPath, fake, '{commands}', md]
        : [process.env.MAXSHELL_GEMMA_PYTHON || path.join(base, 'venv', 'bin', 'python'), path.join(__dirname, 'sage.py'), '--serve', '{commands}', md],
      { cwd: root, env: { ...shell.env, MAXSHELL_GEMMA: path.join(base, gemma.modelFor(k, mode).sub), MAXSHELL_SAGE_NAME: gemma.modelFor(k, mode).name, MAXSHELL_NODE: process.execPath } },
    );
    const startImage = img.ready() ? (o) => new img.Job(o, root, { env: shell.env, free: free() }) : null;
    app = new sage.SageApp({ mode, root, model: key, models: list.map((m) => ({ key: m.key, ready: m.ready })), start, notice: auto.why, startImage, resume: conv });
    if (!list.find((m) => m.key === key).ready) {
      app.status = 'error';
      app.note(`${list.find((m) => m.key === key).label} isn’t set up — in a terminal, run: sage${mode === 'code' ? ' code' : ''} --${list.find((m) => m.key === key).flag} --setup`, 'err');
    }
    if (auto.why) app.note(auto.why);
  }
}

function act(cmd) {
  if (cmd.op === 'quit') { if (app) app.close(); process.exit(0); }
  if (cmd.op === 'open') { open(cmd); return; }
  if (!app) return;
  switch (cmd.op) {
    case 'submit': app.setInput(String(cmd.text || '')); app.submit(); break;
    case 'answer': app.answer(cmd.choice); break;
    case 'stop': if (app.busy || app.approval || app.drawing()) app.interrupt(); break;
    case 'model': app.switchModel(cmd.key); break;
    case 'think': app.setThinking(cmd.level); break;
    case 'new': app.newChat(); break;
    case 'load': app.load(cmd.file); break;
    default: break;
  }
}

// --- the loop: actions in, the engine and jobs polled, state out ------------

let lastSent = '';
let lastAt = 0;
function publish(force) {
  if (!app) return;
  const now = Date.now();
  if (!force && now - lastAt < 50) return; // at most 20 a second
  const state = {
    ev: 'state', id: app.id, mode: app.mode, root: app.root, model: app.model, models: app.media ? [] : models(app.mode),
    status: app.status, speed: app.speed || 0, thinking: app.thinking, thinks: app.thinks,
    waiting: !!app.approval, drawing: !!app.drawing(), items: itemsOf(app),
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
process.stdin.on('end', () => { if (app) app.close(); process.exit(0); });

setInterval(() => {
  if (!app) return;
  try {
    for (const ev of app.engine.poll()) app.onEvent(ev);
    app.tick();
    if (app.toRun) { publish(true); app.work(); }
  } catch (e) { send({ ev: 'error', text: e.message }); }
  publish(false);
}, 40);

process.on('SIGTERM', () => { if (app) app.close(); process.exit(0); });
}

if (require.main === module) main();

module.exports = { math, itemsOf, models };
