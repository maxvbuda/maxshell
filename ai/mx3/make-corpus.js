#!/usr/bin/env node
'use strict';

// Builds mx3's training data: ai/mx3/data/chat.jsonl.
//
//   node ai/mx3/make-corpus.js
//
// Sources, all written for maxshell: mx's chat dataset (deduplicated, and
// rewritten to be mx3), the validated code exercises and programs, generated
// websites, the knowledge articles, mx3's own conversation data (talk.js),
// and the self-check: question/answer pairs labelled yes (the answer fits)
// or no (another question's answer, a near miss sharing a word, or a spliced
// or scrambled answer). In a check example the answer is context only; mx3
// learns to say yes or no, never to give the wrong answer.

const fs = require('fs');
const path = require('path');
const kit = require('../mx2/make-corpus');
const { talkChats } = require('./talk');
const { answerKey, contentWords } = require('../../src/ai');

const { out, rand, pick, chance, vary } = kit;
const OUT = path.join(__dirname, 'data');
const SYS = 'date: Tuesday, September 29, 2026 · time: 10:15 AM';
const CHECK = 'check: does the answer fit?';

// --- mx's chats, as mx3 ---------------------------------------------------------------

const DROP = [
  /if-statement|I’m rules|no rule for|pile of if|I’m just rules/i, // bot's personality, not a neural network's
  /^(\S+! )?Make a file called index\.html/, // the old one-line website answer; mx3 writes real sites
  /^I can chat, answer questions about maxshell/, // the old list of skills
];
const REWRITE = [
  [/about 15 million (parameters|numbers)/g, 'about 43 million $1'],
  [/15 million/g, '43 million'],
  [/in about an hour/g, 'over about a day'],
  [/an eighth the size of GPT-2/g, 'about a third the size of GPT-2'],
  [/\bmx\b(?![-.]\w|3)/g, 'mx3'],
];

function mxChats(perAnswer) {
  const file = path.join(__dirname, '..', 'data', 'dataset.jsonl');
  const seen = new Map();
  let kept = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const c = JSON.parse(line);
    const ai = c.turns.filter((t) => t[0] === 'ai').map((t) => t[1]);
    if (ai.some((t) => DROP.some((re) => re.test(t)))) continue;
    // mx's data repeats its favourite answers thousands of times; keep a few.
    const key = answerKey(ai[ai.length - 1] || '');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > perAnswer) continue;
    c.turns = c.turns.map(([who, t]) => [who, who === 'ai' ? REWRITE.reduce((s, [re, to]) => s.replace(re, to), t) : t]);
    out.push(c);
    kept++;
  }
  return kept;
}

// --- the self-check --------------------------------------------------------------------

// Slices by characters, never splitting an emoji in two.
const chars = (text, from, to) => Array.from(text).slice(from, to).join('');

function shuffleWords(text) {
  const w = text.split(' ');
  for (let i = w.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [w[i], w[j]] = [w[j], w[i]]; }
  return w.join(' ');
}

// Answers are judged from their opening too (ai shows long answers as they
// stream), so many examples cut the answer short.
function cut(text) {
  const n = Array.from(text).length;
  if (n < 80 || chance(0.4)) return chars(text, 0, 600);
  return chars(text, 0, 40 + Math.floor(rand() * Math.min(500, n - 40)));
}

function checkChats(count) {
  // Single exchanges to draw from (the last question and answer of each chat).
  const pool = [];
  for (const c of out) {
    const t = c.turns;
    if (t.length < 2 || t[t.length - 1][0] !== 'ai' || t[t.length - 2][0] !== 'user') continue;
    if (t.some((x) => x[0] === 'sys')) continue;
    pool.push({ sys: c.sys, history: t.slice(0, -2), q: t[t.length - 2][1], a: t[t.length - 1][1] });
  }
  // Which questions each answer belongs to, and which pool items share a word.
  const asked = new Map();
  const byWord = new Map();
  pool.forEach((p, i) => {
    const k = answerKey(p.a);
    if (!asked.has(k)) asked.set(k, new Set());
    asked.get(k).add(p.q.toLowerCase().trim());
    for (const w of contentWords(p.q)) {
      if (!byWord.has(w)) byWord.set(w, []);
      const list = byWord.get(w);
      if (list.length < 3000) list.push(i);
    }
  });
  // A wrong answer must really be wrong for this question.
  const wrongFor = (p, cand) => {
    if (!cand || answerKey(cand.a) === answerKey(p.a)) return false;
    if (asked.get(answerKey(cand.a)).has(p.q.toLowerCase().trim())) return false;
    const mine = new Set(contentWords(p.q));
    const theirs = contentWords(cand.q);
    const shared = theirs.filter((w) => mine.has(w)).length;
    return shared / Math.max(1, Math.min(mine.size, theirs.length)) < 0.6;
  };
  let made = 0;
  for (let tries = 0; made < count && tries < count * 5; tries++) {
    const p = pick(pool);
    let answer = p.a;
    let fits = chance(0.5);
    if (!fits) {
      const r = rand();
      if (r < 0.35) {
        const cand = pick(pool);
        if (!wrongFor(p, cand)) continue;
        answer = cand.a;
      } else if (r < 0.7) {
        // A near miss: the answer to another question with a word in common.
        const words = contentWords(p.q);
        if (!words.length) continue;
        const list = byWord.get(pick(words)) || [];
        const cand = pool[pick(list)];
        if (!wrongFor(p, cand)) continue;
        answer = cand.a;
      } else if (r < 0.85) {
        // Spliced: starts right, then wanders off into another answer.
        const other = pick(pool).a;
        const half = Math.max(12, Math.floor(p.a.length * (0.3 + rand() * 0.4)));
        if (answerKey(other) === answerKey(p.a)) continue;
        answer = `${chars(p.a, 0, half)}${chars(other, Math.floor(Array.from(other).length / 2))}`;
      } else {
        // Scrambled words: fluent-looking nonsense.
        if (p.a.split(' ').length < 6) continue;
        answer = shuffleWords(p.a);
      }
    }
    const history = chance(0.25) ? p.history : [];
    out.push({
      sys: p.sys,
      turns: [...history, ['user', p.q], ['ai', cut(answer), false], ['sys', CHECK], ['ai', fits ? 'yes' : 'no']],
    });
    made++;
  }
  return made;
}

// --- go ------------------------------------------------------------------------------------

function main() {
  const counts = [];
  const step = (label, fn) => {
    const before = out.length;
    const n = fn();
    counts.push(`  ${label.padEnd(12)} ${typeof n === 'number' ? n : out.length - before}`);
  };
  step('mx chats', () => mxChats(25));
  step('code', () => kit.codeChats(45));
  step('websites', () => kit.siteChats(1500));
  step('knowledge', () => { for (let i = 0; i < 2; i++) kit.knowledgeChats(); });
  step('talk', () => { for (const t of talkChats(rand, { repeat: 40 })) out.push({ sys: SYS, turns: t }); });
  // mx3 talks about itself as mx3 everywhere.
  for (const c of out) c.turns = c.turns.map((t) => (t[0] === 'ai' ? [t[0], t[1].replace(/\bI’m mx2\b/g, 'I’m mx3')] : t));
  step('self-check', () => checkChats(70000));
  process.stderr.write(`${counts.join('\n')}\n`);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'chat.jsonl');
  fs.writeFileSync(file, `${out.map((c) => JSON.stringify(c)).join('\n')}\n`);
  process.stderr.write(`wrote ${out.length} conversations, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB → ai/mx3/data/chat.jsonl\n`);
}

main();
module.exports = { vary };
