'use strict';

// mx, the on-device model: tokenizer, prompt building, sampling, and the
// forward pass (when a trained model is in models/).

const assert = require('assert');
const ai = require('../src/ai');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok - ${name}\n  ${e.message}`);
  }
}

// A seeded random source, so generation is repeatable.
function seeded(s) {
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

const have = ai.available();
if (!have) console.log('  (no trained model in models/ — model tests skipped)');

test('the context line carries the date, time and name', () => {
  const line = ai.contextLine(new Date(2026, 8, 29, 14, 5), 'Max');
  assert.strictEqual(line, 'date: Tuesday, September 29, 2026 · time: 2:05 PM · user: Max');
  assert.strictEqual(ai.contextLine(new Date(2026, 0, 1, 0, 7)), 'date: Thursday, January 1, 2026 · time: 12:07 AM');
});

test('sampling: temperature 0 takes the best, banned tokens never come out', () => {
  const logits = new Float32Array([0.1, 3, 2, 5]);
  assert.strictEqual(ai.sampleToken(logits, { temperature: 0 }), 3);
  assert.strictEqual(ai.sampleToken(logits, { temperature: 0, banned: new Set([3]) }), 1);
  for (let i = 0; i < 50; i++) assert.ok([3, 1].includes(ai.sampleToken(logits, { topK: 2, rand: seeded(i) })));
});

test('your name is picked up from the chat, but not from “I am tired”', () => {
  const asked = ['ai', 'Hi! 👋 I’m mx. What’s your name?'];
  assert.strictEqual(ai.nameFrom([['user', 'hi'], asked, ['user', 'max']]), 'Max');
  assert.strictEqual(ai.nameFrom([['user', 'hi'], asked, ['user', "i'm Priya"]]), 'Priya');
  assert.strictEqual(ai.nameFrom([['user', 'my name is Ada and I like cats']]), 'Ada');
  assert.strictEqual(ai.nameFrom([['user', 'call me Zed']]), 'Zed');
  assert.strictEqual(ai.nameFrom([['user', 'i am tired']]), null);
  assert.strictEqual(ai.nameFrom([['user', 'hi'], asked, ['user', 'no']]), null);
  assert.strictEqual(ai.nameFrom([['user', 'how do i make a tab']]), null);
});

test('the name guard fixes the wrong name and leaves the rest alone', () => {
  assert.strictEqual(ai.guardName('Nice to meet you, Nora! 😊', 'Max'), 'Nice to meet you, Max! 😊');
  assert.strictEqual(ai.guardName('You’re Alex! 😊', 'Max'), 'You’re Max! 😊');
  assert.strictEqual(ai.guardName('Nora, press ⌘T.', 'Max'), 'Max, press ⌘T.');
  assert.strictEqual(ai.guardName('Press ⌘T to open a tab.', 'Max'), 'Press ⌘T to open a tab.');
  assert.strictEqual(ai.guardName('Hi Max! 👋', 'Max'), 'Hi Max! 👋');
  assert.strictEqual(ai.guardName('The capital of France is Paris.', 'Max'), 'The capital of France is Paris.');
  assert.strictEqual(ai.guardName('Nice to meet you, Nora!', null), 'Nice to meet you, Nora!');
});

test('the tokenizer round-trips any text, emoji included', () => {
  if (!have) return;
  const { tok } = ai.load();
  for (const s of ['hello world', 'What’s 12 × 7? 🙂', 'ls -la ~/maxshell | grep "x"', 'naïve café — 日本語', '  spaces   and\ttabs\n']) {
    assert.strictEqual(tok.decode(tok.encode(s)), s);
  }
  assert.ok(tok.encode('the terminal is a place').length < 'the terminal is a place'.length / 2, 'merges compress text');
});

test('prompts fit the context, dropping the oldest turns first', () => {
  if (!have) return;
  const { tok, model } = ai.load();
  const turns = [];
  for (let i = 0; i < 40; i++) turns.push(['user', `message number ${i} with some words in it`], ['ai', `reply number ${i}`]);
  const ids = ai.promptTokens(tok, ai.contextLine(), turns, 160);
  assert.ok(ids.length <= 160);
  assert.strictEqual(ids[0], tok.special['<|doc|>']);
  assert.strictEqual(ids[ids.length - 1], tok.special['<|ai|>']);
  assert.ok(tok.decode(ids).includes('reply number 39'), 'the newest turn is kept');
  assert.ok(!tok.decode(ids).includes('number 0 '), 'the oldest turn is dropped');
  assert.ok(model.config.ctx >= 128);
});

test('the model replies with clean text, repeatably for a fixed seed', () => {
  if (!have) return;
  const a = ai.reply([['user', 'hi! how are you?']], { name: 'Max', rand: seeded(1) });
  const b = ai.reply([['user', 'hi! how are you?']], { name: 'Max', rand: seeded(1) });
  assert.strictEqual(a, b);
  assert.ok(a.length > 0 && a.length < 800);
  assert.ok(!/<\|/.test(a), 'no special tokens in the text');
  assert.ok(!a.includes('�'), 'no broken characters');
});

test('streamed pieces add up to the reply', () => {
  if (!have) return;
  let streamed = '';
  const text = ai.reply([['user', 'tell me a joke']], { rand: seeded(7), onText: (p) => { streamed += p; } });
  assert.strictEqual(streamed.trim(), text);
});

test('training status notices a pause for sleep, and the resume after it', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-status-'));
  const log = path.join(dir, 'train.log');
  const steps = 'run: --steps 7500 --batch 8x4 --lr 0.0006\nmodel: 42.70M parameters\nstep     50  loss 6.100  lr 6.00e-05  1.0 min  (~20.0 h left)\n';
  fs.writeFileSync(log, `${steps}  ⏸ Mac going to sleep — saving and pausing (22:10)\n  saved at step 52\n    progress saved (22:10)\n`);
  let st = ai.trainingStatus(log);
  assert.strictEqual(st.total, 7500);
  assert.ok(st.asleep, 'paused while asleep');
  assert.strictEqual(st.sleeps, 1);
  fs.appendFileSync(log, '  ▶ Mac awake — training resumed (07:30)\nstep    100  loss 5.200  lr 1.20e-04  3.0 min  (~19.0 h left)\n');
  st = ai.trainingStatus(log);
  assert.ok(!st.asleep, 'running again after wake');
  assert.match(st.lastEvent, /awake .* at 07:30/);
  fs.appendFileSync(log, 'run: --steps 9000 --batch 8x4 --lr 0.0003\nresumed from step 100\n');
  assert.strictEqual(ai.trainingStatus(log).total, 9000, 'an extended schedule counts');
  fs.appendFileSync(log, '  ⏸ Mac low on memory (9% free) — saved at step 100, waiting (23:40)\n');
  st = ai.trainingStatus(log);
  assert.ok(st.asleep && /low on memory .* at 23:40/.test(st.lastEvent), 'paused for memory');
  fs.appendFileSync(log, '  ▶ memory free again — training resumed (23:52)\nstep    150  loss 5.000  lr 1.20e-04  5.0 min  (~18.0 h left)\n');
  assert.ok(!ai.trainingStatus(log).asleep, 'running again once memory is free');
  fs.rmSync(dir, { recursive: true });
});

test('time left reads in hours, days and weeks', () => {
  assert.strictEqual(ai.duration(514), '8 hours 34 minutes');
  assert.strictEqual(ai.duration(60), '1 hour');
  assert.strictEqual(ai.duration(3000), '2 days 2 hours');
  assert.strictEqual(ai.duration(12000), '1 week 1 day');
  assert.strictEqual(ai.duration(45), '45 minutes');
});

test('models are shown by version: mx3 is mx 0.0.3', () => {
  assert.strictEqual(ai.versionName('mx3'), 'mx 0.0.3');
  assert.strictEqual(ai.versionName('mx'), 'mx 0.0.1');
  assert.strictEqual(ai.shortName('mx 0.0.4'), 'mx4');
  assert.strictEqual(ai.shortName('0.0.1'), 'mx');
  assert.strictEqual(ai.shortName('mx3'), 'mx3');
  assert.strictEqual(ai.ownName('I’m mx3: a small language model'), 'I’m mx 0.0.3: a small language model');
});

test('the training service restarts on failure and starts at login', () => {
  const plist = ai.servicePlist('/x/maxshell');
  assert.match(plist, /<string>\/x\/maxshell\/ai\/mx2\/run-training.sh<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
});

test('relevance: the words that matter, and answers keyed without names or numbers', () => {
  assert.deepStrictEqual(ai.contentWords('How do I take a screenshot?'), ['take', 'screenshot']);
  assert.deepStrictEqual(ai.contentWords('whats up'), ['whats', 'up'], 'small talk keeps every word');
  assert.strictEqual(ai.answerKey('Nice to meet you, Max! It’s 7:05 PM.', 'Max'), ai.answerKey('Nice to meet you, NAME! It’s 9:41 PM.'));
});

test('ai shows a checked reply: fitting answers, and no made-up ones', () => {
  if (!have) return;
  const intro = ai.checkedReply([['user', 'hi'], ['ai', 'Hi! 👋 I’m mx. What’s your name?'], ['user', 'Max']], { rand: seeded(1) });
  assert.match(intro.text, /Max/);
  const shot = ai.checkedReply([['user', 'how do i take a screenshot']], { rand: seeded(1) });
  assert.match(shot.text, /⌘⇧3|⌘⇧4|⌘⇧5/);
  // Words it was never taught: an honest answer, not a memorized one for something else.
  const odd = ai.checkedReply([['user', 'explain the quorblex flux capacitance']], { rand: seeded(1) });
  assert.strictEqual(odd.source, 'honest', odd.text);
});

// A tiny random mx2 in the export format, and a plain reference forward
// pass to check the WebAssembly runtime against.
function tinyMx2(dir) {
  const fs = require('fs');
  const path = require('path');
  const cfg = { arch: 'mx2', vocab: 300, ctx: 300, d: 64, layers: 2, heads: 4, hidden: 192 };
  const r = seeded(11);
  const tensors = [];
  const blobs = [];
  let offset = 0;
  const add = (name, arr, dtype, shape) => {
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    tensors.push({ name, dtype, shape, offset });
    blobs.push(b);
    offset += b.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { blobs.push(Buffer.alloc(pad)); offset += pad; }
  };
  const ref = {};
  const mat = (name, rows, cols) => {
    const q = Int8Array.from({ length: rows * cols }, () => Math.round((r() * 2 - 1) * 127));
    const sc = Float32Array.from({ length: rows }, () => 0.02 / 127 * (1 + r()) * 8);
    add(name, q, 'i8', [rows, cols]);
    add(`${name}.scale`, sc, 'f32', [rows]);
    ref[name] = (i, j) => q[i * cols + j] * sc[i];
  };
  const vec = (name, n) => { const f = Float32Array.from({ length: n }, () => 0.5 + r()); add(name, f, 'f32', [n]); ref[name] = f; };
  const { vocab, d, layers, hidden } = cfg;
  mat('emb.weight', vocab, d);
  for (let l = 0; l < layers; l++) {
    const p = `blocks.${l}.`;
    vec(`${p}norm1.weight`, d);
    for (const w of ['wq', 'wk', 'wv', 'wo']) mat(`${p}${w}.weight`, d, d);
    vec(`${p}norm2.weight`, d);
    mat(`${p}w1.weight`, hidden, d);
    mat(`${p}w3.weight`, hidden, d);
    mat(`${p}w2.weight`, d, hidden);
  }
  vec('norm.weight', d);
  const header = Buffer.from(JSON.stringify({ config: cfg, tensors, meta: {} }));
  const pad = Buffer.alloc((4 - ((8 + header.length) % 4)) % 4);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  const file = path.join(dir, 'mx2.bin');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('MXAI'), len, header, pad, ...blobs]));
  return { file, cfg, ref };
}

function referenceLogits({ cfg, ref }, tokens) {
  const { d, layers, heads, hidden, vocab } = cfg;
  const hd = d / heads;
  const mv = (w, x, rows) => Array.from({ length: rows }, (_, i) => x.reduce((s, v, j) => s + ref[w](i, j) * v, 0));
  const norm = (x, g) => { const ms = x.reduce((s, v) => s + v * v, 0) / x.length; return x.map((v, i) => (v / Math.sqrt(ms + 1e-5)) * g[i]); };
  const rope = (v, pos) => {
    const out = v.slice();
    for (let h = 0; h < heads; h++) {
      for (let i = 0; i < hd / 2; i++) {
        const a = pos / 10000 ** ((2 * i) / hd);
        const j = h * hd + 2 * i;
        out[j] = v[j] * Math.cos(a) - v[j + 1] * Math.sin(a);
        out[j + 1] = v[j] * Math.sin(a) + v[j + 1] * Math.cos(a);
      }
    }
    return out;
  };
  const K = Array.from({ length: layers }, () => []);
  const V = Array.from({ length: layers }, () => []);
  let x;
  tokens.forEach((tok, pos) => {
    x = Array.from({ length: d }, (_, i) => ref['emb.weight'](tok, i));
    for (let l = 0; l < layers; l++) {
      const p = `blocks.${l}.`;
      const h = norm(x, ref[`${p}norm1.weight`]);
      const q = rope(mv(`${p}wq.weight`, h, d), pos);
      K[l].push(rope(mv(`${p}wk.weight`, h, d), pos));
      V[l].push(mv(`${p}wv.weight`, h, d));
      const att = new Array(d).fill(0);
      for (let hh = 0; hh < heads; hh++) {
        const sc = K[l].map((k) => { let s = 0; for (let i = 0; i < hd; i++) s += q[hh * hd + i] * k[hh * hd + i]; return s / Math.sqrt(hd); });
        const mx = Math.max(...sc);
        const e = sc.map((v) => Math.exp(v - mx));
        const sum = e.reduce((a, b) => a + b, 0);
        e.forEach((w, t) => { for (let i = 0; i < hd; i++) att[hh * hd + i] += (w / sum) * V[l][t][hh * hd + i]; });
      }
      mv(`${p}wo.weight`, att, d).forEach((v, i) => { x[i] += v; });
      const h2 = norm(x, ref[`${p}norm2.weight`]);
      const g = mv(`${p}w1.weight`, h2, hidden);
      const u = mv(`${p}w3.weight`, h2, hidden);
      mv(`${p}w2.weight`, g.map((a, i) => (a / (1 + Math.exp(-a))) * u[i]), d).forEach((v, i) => { x[i] += v; });
    }
  });
  return mv('emb.weight', norm(x, ref['norm.weight']), vocab);
}

test('mx2 runtime matches a plain reference, in chunks, one token at a time, and on threads', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Model2 } = require('../src/mx2');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx2-'));
  const tiny = tinyMx2(dir);
  const tokens = Array.from({ length: 140 }, (_, i) => (i * 37 + 5) % 300); // more than one 128-token chunk
  const want = referenceLogits(tiny, tokens);
  const close = (got, label) => {
    let worst = 0;
    want.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - got[i])); });
    assert.ok(worst < 1e-3, `${label}: off by ${worst}`);
  };
  const solo = new Model2(tiny.file, { threads: 0 });
  close(solo.feed(tokens), 'whole prompt');
  solo.reset();
  let last;
  for (const t of tokens) last = solo.step(t);
  close(last, 'token by token');
  const pool = new Model2(tiny.file, { threads: 2 });
  assert.strictEqual(pool.workers.length, 2, 'workers started');
  pool.feed(tokens.slice(0, 70));
  close(pool.feed(tokens.slice(70)), 'on worker threads');
  pool.close();
  fs.rmSync(dir, { recursive: true });
});

if (failures) {
  console.error(`\n${failures} ai test(s) failed`);
  process.exit(1);
}
console.log('\nall ai tests passed');
