'use strict';

// How much of what a model writes is copied from its training data?
// Indexes every run of N words in the training answers, then for a piece of
// generated text reports the share of its N-word runs found verbatim, and
// the longest copied stretch (in words). Code is compared word by word too,
// so a recited program shows up as one long copied stretch.
//
//   const idx = buildIndex('ai/mx3/data/chat.jsonl');
//   copied(idx, text) → { share: 0.83, longest: 212, words: 260 }

const fs = require('fs');

const N = 8;

function words(text) {
  return text.toLowerCase().match(/[a-z0-9_]+|[^\sa-z0-9_]/g) || [];
}

// FNV-1a over the N words: a 32-bit key per run, kept in a Set.
function key(ws, i) {
  let h = 0x811c9dc5;
  for (let k = i; k < i + N; k++) {
    const w = ws[k];
    for (let j = 0; j < w.length; j++) { h ^= w.charCodeAt(j); h = Math.imul(h, 0x01000193); }
    h ^= 32; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function buildIndex(file) {
  const seen = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    for (const turn of JSON.parse(line).turns) {
      if (turn[0] !== 'ai' || turn[2] === false) continue;
      const ws = words(turn[1]);
      for (let i = 0; i + N <= ws.length; i++) seen.add(key(ws, i));
    }
  }
  return seen;
}

function copied(index, text) {
  const ws = words(text);
  if (ws.length < N) return { share: 0, longest: 0, words: ws.length };
  let hits = 0;
  let run = 0;
  let longest = 0;
  for (let i = 0; i + N <= ws.length; i++) {
    if (index.has(key(ws, i))) {
      hits++;
      run = run ? run + 1 : N;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return { share: hits / (ws.length - N + 1), longest, words: ws.length };
}

module.exports = { buildIndex, copied, words };
