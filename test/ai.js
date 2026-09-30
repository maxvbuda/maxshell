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
  fs.rmSync(dir, { recursive: true });
});

test('the training service restarts on failure and starts at login', () => {
  const plist = ai.servicePlist('/x/maxshell');
  assert.match(plist, /<string>\/x\/maxshell\/ai\/mx2\/run-training.sh<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
});

if (failures) {
  console.error(`\n${failures} ai test(s) failed`);
  process.exit(1);
}
console.log('\nall ai tests passed');
