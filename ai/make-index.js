'use strict';

// Builds models/<model>-index.json: for every answer in the training data
// (by its opening), the words of the questions it answered. At chat time,
// src/ai.js looks up the model's reply here: a memorized answer that belongs
// to questions with nothing in common with yours is the model mixing things
// up, so it isn't shown.
//
//   node ai/make-index.js                       (mx: ai/data/dataset.jsonl)
//   node ai/make-index.js ai/mx2/data/chat.jsonl mx2

const fs = require('fs');
const path = require('path');
const { answerKey, contentWords, nameFrom } = require('../src/ai');

const file = process.argv[2] || path.join(__dirname, 'data', 'dataset.jsonl');
const name = process.argv[3] || 'mx';
const answers = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue;
  const c = JSON.parse(line);
  const known = (/user: ([^·]+?)(?: ·|$)/.exec(c.sys) || [])[1] || null;
  for (let i = 1; i < c.turns.length; i++) {
    if (c.turns[i][0] !== 'ai' || c.turns[i - 1][0] !== 'user') continue;
    const user = nameFrom(c.turns.slice(0, i)) || known;
    const key = answerKey(c.turns[i][1], user);
    if (!answers.has(key)) answers.set(key, new Set());
    const set = answers.get(key);
    const asked = user ? c.turns[i - 1][1].replace(new RegExp(`\\b${user}\\b`, 'gi'), ' ') : c.turns[i - 1][1];
    if (set.size < 400) for (const w of contentWords(asked)) set.add(w);
  }
}
const vocab = new Map();
const out = {};
for (const [key, words] of answers) {
  out[key] = [...words].map((w) => {
    if (!vocab.has(w)) vocab.set(w, vocab.size);
    return vocab.get(w);
  });
}
const dest = path.join(__dirname, '..', 'models', `${name}-index.json`);
fs.writeFileSync(dest, JSON.stringify({ words: [...vocab.keys()], answers: out }));
console.log(`${answers.size} answers, ${vocab.size} words → ${path.relative(process.cwd(), dest)} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
