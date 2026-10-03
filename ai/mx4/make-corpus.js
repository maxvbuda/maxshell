#!/usr/bin/env node
'use strict';

// mx4's chat-stage data: ai/mx4/data/chat.jsonl.
//
// Mostly code that can't be memorized wholesale: generated programs (every
// one different), edit / translate / fix-the-bug tasks with the code in the
// message, games and apps (each a variation, all played by gamecheck), the
// hand-written exercises, plus mx3's conversation and knowledge data so it
// still chats. Some things are held out completely (HOLDOUT) so the exam
// can test what it never saw. No answer appears more than 3 times.
//
//   node ai/mx4/make-corpus.js

const fs = require('fs');
const path = require('path');
const kit = require('../mx2/make-corpus');
const { gameConversation, followUp, KINDS } = require('./gamegen');
const { appConversation, APPS } = require('./apps-web');
const { pyGameConversation, pyCheck } = require('./games-py');
const { programConversation, editConversation } = require('./progen');
const { playCheck } = require('./gamecheck');
const { chatConversation } = require('./chatgen');
const { contextLine } = require('../../src/ai');

const HOLDOUT = {
  games: new Set(['catcher', 'reaction']),
  pyGames: new Set(['dice']),
  apps: new Set(['stopwatch', 'tipcalc']),
  // Phrases and the code they become, so edits and translations can't leak them.
  steps: /cubes? each one|cube each|\*\* 3|removes? the vowels|remove the vowels|not in "aeiou"|\[aeiou\]\/gi, ''/,
  exercises: new Set(['calculate the area of a circle', 'convert fahrenheit to celsius', 'find the second largest number in a list', 'count the lines in a text',
    'check if a number is an armstrong number', 'reverse the words in a sentence', 'find all the divisors of a number', 'make a class that inherits from another',
    'chunk a list into groups of three', 'swap two variables']),
};

const { rand, pick, chance } = kit;
const out = [];
const NAMES = ['Max', 'Ada', 'Sam', 'Priya', 'Leo', 'Zoe', 'Omar', 'Mia'];
const sys = () => contextLine(new Date(2025 + Math.floor(rand() * 3), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28), Math.floor(rand() * 24), Math.floor(rand() * 60)), chance(0.2) ? pick(NAMES) : null);
const add = (turns) => out.push({ sys: sys(), turns });

function games(n) {
  let bad = 0;
  const kinds = Object.keys(KINDS).filter((k) => !HOLDOUT.games.has(k));
  for (let i = 0; i < n; i++) {
    const c = gameConversation(rand, pick(kinds));
    if (playCheck(c.html)) { bad++; continue; }
    const turns = [['user', c.request], ['ai', c.reply]];
    if (chance(0.3)) { const [q, a] = followUp(rand, c.kind); turns.push(['user', q], ['ai', a]); }
    add(turns);
  }
  return bad;
}

function apps(n) {
  const kinds = Object.keys(APPS).filter((k) => !HOLDOUT.apps.has(k));
  for (let i = 0; i < n; i++) {
    const c = appConversation(rand, pick(kinds));
    if (!playCheck(c.html)) add([['user', c.request], ['ai', c.reply]]);
  }
}

function pyGames(n) {
  for (let i = 0; i < n; i++) {
    const c = pyGameConversation(rand);
    if (HOLDOUT.pyGames.has(c.kind) || pyCheck(c.code, c.stdin, c.expect)) continue;
    add([['user', c.request], ['ai', c.reply]]);
  }
}

function programs(n, edits) {
  let made = 0;
  while (made < n) {
    const c = programConversation(rand);
    if (HOLDOUT.steps.test(c.request)) continue;
    add([['user', c.request], ['ai', c.reply]]);
    made++;
  }
  made = 0;
  while (made < edits) {
    const c = editConversation(rand);
    if (HOLDOUT.steps.test(c.request + c.reply)) continue;
    add([['user', c.request], ['ai', c.reply]]);
    made++;
  }
}

// mx3's chat, knowledge and self-check data — without its code answers,
// which the sources above replace.
function mx3Chats() {
  const file = path.join(__dirname, '..', 'mx3', 'data', 'chat.jsonl');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const c = JSON.parse(line);
    const text = c.turns.map((t) => t[1]).join('\n');
    const isCheck = c.turns.some((t) => t[0] === 'sys');
    // Code (even as context in a self-check) comes from the sources above.
    if (/```/.test(text)) continue;
    if ([...HOLDOUT.exercises].some((task) => text.toLowerCase().includes(task))) continue;
    if (isCheck && chance(0.6)) continue;
    c.turns = c.turns.map((t) => (t[0] === 'ai' && t[2] !== false ? [t[0], t[1].replace(/\bmx3\b/g, 'mx4').replace(/about 43 million/g, 'about 91 million')] : t));
    out.push(c);
  }
}

function capRepeats(max) {
  const seen = new Map();
  let dropped = 0;
  const kept = out.filter((c) => {
    const last = c.turns.filter((t) => t[0] === 'ai').map((t) => t[1]).join('\u0000');
    const n = (seen.get(last) || 0) + 1;
    seen.set(last, n);
    if (n > max) { dropped++; return false; }
    return true;
  });
  out.length = 0;
  for (const c of kept) out.push(c);
  return dropped;
}

function main() {
  const counts = [];
  const step = (label, fn) => { const b = out.length; const extra = fn(); counts.push(`  ${label.padEnd(14)} ${out.length - b}${extra ? ` (${extra} failed their check)` : ''}`); };
  step('programs', () => programs(70000, 30000));
  step('games', () => games(3300));
  step('apps', () => apps(1800));
  step('python games', () => pyGames(800));
  step('exercises', () => { const before = kit.out.length; kit.codeChats(10, HOLDOUT.exercises); for (const c of kit.out.splice(before)) add(c.turns); });
  step('websites', () => { const before = kit.out.length; kit.siteChats(600); for (const c of kit.out.splice(before)) add(c.turns); });
  step('conversation', () => { for (let i = 0; i < 45000; i++) add(chatConversation(rand)); });
  step('mx3 chats', () => mx3Chats());
  const dropped = capRepeats(3);
  for (const c of out) c.turns = c.turns.map((t) => (t[0] === 'ai' && t[2] !== false ? [t[0], t[1].replace(/\bI’m mx2\b|\bI’m mx3\b/g, 'I’m mx4')] : t));
  process.stderr.write(`${counts.join('\n')}\n  (${dropped} repeats over the cap dropped)\n`);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(file, `${out.map((c) => JSON.stringify(c)).join('\n')}\n`);
  process.stderr.write(`wrote ${out.length} conversations, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB → ai/mx4/data/chat.jsonl\n`);
}

main();
module.exports = { HOLDOUT };
