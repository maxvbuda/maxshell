'use strict';

const fs = require('fs');
const path = require('path');

// The statistical half of `bot`, fully offline:
//
//  - a word-trigram Markov chain trained on text that ships with maxshell
//    (src/botcorpus.txt plus the README's prose). It strings words together
//    the way they followed each other in that text — GPT-2-ish rambling with
//    no neural network, and it knows nothing beyond its corpus;
//  - retrieval over the README: the section whose words best match a
//    question (TF-IDF), for "how does X work in maxshell" questions.

const ROOT = path.resolve(__dirname, '..');
const START = '<s>';
const END = '</s>';

const STOPWORDS = new Set(('a an the and or but if then so to of in on at by for with from as is are was were be been being am '
  + 'i you he she it we they me my your our their this that these those what which who whom how why when where '
  + 'do does did done can could will would should shall may might must have has had not no yes just very really '
  + 'about into over under up down out there here than too also only its it is one some any all more most such '
  + 'tell please get got want like know think make let us bot maxshell').split(' '));

function tokenize(sentence) {
  return sentence.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .match(/[A-Za-z0-9][A-Za-z0-9'’-]*|[.,!?;:]/g) || [];
}

// Sentences from plain text: split on end punctuation.
function sentences(text) {
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.trim()).filter((s) => s.length > 12);
}

// Prose from the README: code blocks, headings, tables and lists removed;
// inline `code` keeps its text.
function readmeProse(md) {
  return md.replace(/```[\s\S]*?```/g, '\n').split('\n')
    .filter((l) => !/^\s*(#|\||    |-{3,}|[-*] |\d+\. )/.test(l))
    .join('\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2');
}

// A crude stemmer, so "suspend", "suspends" and "suspended" meet.
function stem(word) {
  let w = word.toLowerCase();
  if (/ies$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ch|sh|x|z|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (/[^su]s$/.test(w) && w.length > 3) w = w.slice(0, -1);
  if (/ing$/.test(w) && w.length > 5) w = w.slice(0, -3);
  else if (/ed$/.test(w) && w.length > 4) w = w.slice(0, -2);
  return w.replace(/(.)\1$/, '$1').replace(/e$/, '');
}

class MarkovModel {
  constructor() {
    this.forward = new Map();  // "w1 w2" → Map(next → count)
    this.backward = new Map(); // "w2 w3" → Map(prev → count)
    this.vocab = new Map();    // lower-case word → count
    this.sentences = new Set();
  }

  add(sentence) {
    const words = tokenize(sentence);
    if (words.length < 4) return;
    this.sentences.add(words.join(' ').toLowerCase());
    const seq = [START, START, ...words, END, END];
    const bump = (table, key, word) => {
      let m = table.get(key);
      if (!m) { m = new Map(); table.set(key, m); }
      m.set(word, (m.get(word) || 0) + 1);
    };
    for (let i = 2; i < seq.length - 1; i++) {
      bump(this.forward, `${seq[i - 2]} ${seq[i - 1]}`, seq[i]);
      bump(this.backward, `${seq[i]} ${seq[i + 1]}`, seq[i - 1]);
    }
    for (const w of words) if (/^[a-z]/i.test(w)) this.vocab.set(w.toLowerCase(), (this.vocab.get(w.toLowerCase()) || 0) + 1);
  }

  static sample(counts, rand) {
    let total = 0;
    for (const c of counts.values()) total += c;
    let r = rand() * total;
    for (const [w, c] of counts) { r -= c; if (r <= 0) return w; }
    return [...counts.keys()][0];
  }

  // Positions where `word` appears: [prev, word, next] triples to start from.
  seeds(word) {
    const out = [];
    const lw = word.toLowerCase();
    for (const [key, nexts] of this.forward) {
      const [a, b] = key.split(' ');
      if (b.toLowerCase() === lw) for (const n of nexts.keys()) out.push([a, b, n]);
    }
    return out;
  }

  // One sentence: from a seed word, backwards to a sentence start and
  // forwards to an end; or from the start if there's no seed.
  generate({ seed = null, rand = Math.random, maxWords = 40 } = {}) {
    let words;
    if (seed) {
      const starts = this.seeds(seed);
      if (!starts.length) return null;
      const [a, b, c] = starts[Math.floor(rand() * starts.length)];
      words = [b];
      // Backwards from the seed to the start of a sentence…
      let [x, y] = [a, b];
      while (x !== START && words.length < maxWords) {
        words.unshift(x);
        const counts = this.backward.get(`${x} ${y}`);
        if (!counts) break;
        const p = MarkovModel.sample(counts, rand);
        [x, y] = [p, x];
      }
      // …then forwards to its end.
      let [p1, p2] = [b, c];
      while (p2 !== END && words.length < maxWords) {
        words.push(p2);
        const counts = this.forward.get(`${p1} ${p2}`);
        if (!counts) break;
        const n = MarkovModel.sample(counts, rand);
        [p1, p2] = [p2, n];
      }
    } else {
      words = [];
      let [x, y] = [START, START];
      for (;;) {
        const counts = this.forward.get(`${x} ${y}`);
        if (!counts) break;
        const n = MarkovModel.sample(counts, rand);
        if (n === END || words.length >= maxWords) break;
        words.push(n);
        [x, y] = [y, n];
      }
    }
    return detokenize(words);
  }
}

function detokenize(words) {
  let text = words.filter((w) => w !== START && w !== END).join(' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s+'/g, "'");
  if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}

// Is a generated sentence worth showing? Sensible length, ends properly,
// no phrase said twice, balanced quotes.
function wellFormed(text) {
  if (!text) return false;
  const words = text.split(/\s+/);
  if (words.length < 5 || words.length > 32) return false;
  if (!/[.!?]$/.test(text)) return false;
  if ((text.match(/"/g) || []).length % 2) return false;
  const lower = words.map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, ''));
  const grams = new Set();
  for (let i = 0; i + 2 < lower.length; i++) {
    const g = lower.slice(i, i + 3).join(' ');
    if (grams.has(g)) return false;
    grams.add(g);
  }
  return true;
}

let model = null;

function loadModel() {
  if (model) return model;
  model = new MarkovModel();
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  for (const s of sentences(read(path.join(__dirname, 'botcorpus.txt')))) model.add(s);
  // README prose too — but not sentences full of code, which ramble badly.
  for (const s of sentences(readmeProse(read(path.join(ROOT, 'README.md'))))) {
    if (!/[`~$|{}<>\\/]|\s-\w/.test(s)) model.add(s);
  }
  return model;
}

// Content words of a message, most distinctive first.
function keywords(text) {
  return (text.toLowerCase().match(/[a-z][a-z'-]+/g) || [])
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .sort((a, b) => b.length - a.length);
}

// One or two generated sentences about the message's keywords, or null.
function ramble(message, { rand = Math.random, tries = 60 } = {}) {
  const m = loadModel();
  const known = keywords(message).filter((w) => m.vocab.has(w));
  let best = null;
  for (let i = 0; i < tries; i++) {
    const seed = known.length ? known[i % known.length] : null;
    const s = m.generate({ seed, rand });
    if (!wellFormed(s)) continue;
    const copied = m.sentences.has(tokenize(s).join(' ').toLowerCase());
    // Mentioning what you asked about matters most; a fresh combination is
    // a small bonus (a copied sentence is at least coherent).
    const score = (seed && s.toLowerCase().includes(seed) ? 3 : 0) + (copied ? 0 : 1) + Math.min(1, s.split(' ').length / 12);
    if (!best || score > best.score) best = { text: s, score };
    if (score >= 4.9) break;
  }
  if (!best) return null;
  let text = best.text;
  // Sometimes a second, unseeded sentence, for a bit more flow.
  if (rand() < 0.3) {
    const other = known.find((w) => !text.toLowerCase().includes(w));
    for (let i = 0; i < 20; i++) {
      const extra = m.generate({ seed: other || null, rand });
      if (wellFormed(extra) && extra !== text && (text + extra).split(' ').length <= 40) { text += ` ${extra}`; break; }
    }
  }
  return text;
}

// --- retrieval over the README ------------------------------------------------

let sections = null;

function readmeSections() {
  if (sections) return sections;
  let md = '';
  try { md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'); } catch { /* no README */ }
  sections = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h) {
      cur = { title: h[1].replace(/[`*]/g, '').trim(), body: [] };
      sections.push(cur);
    } else if (cur) cur.body.push(line);
  }
  for (const s of sections) {
    s.text = s.body.join('\n');
    s.words = keywords(`${s.title} ${s.text.replace(/`/g, ' ')}`).map(stem);
    s.titleWords = new Set(keywords(s.title).map(stem));
  }
  // Inverse document frequency.
  const df = new Map();
  for (const s of sections) for (const w of new Set(s.words)) df.set(w, (df.get(w) || 0) + 1);
  const n = sections.length || 1;
  for (const s of sections) {
    s.tf = new Map();
    for (const w of s.words) s.tf.set(w, (s.tf.get(w) || 0) + 1);
    s.idf = (w) => Math.log((n + 1) / ((df.get(w) || 0) + 1));
  }
  return sections;
}

// The README section that best answers a question: { title, excerpt, score }.
function retrieve(question) {
  const words = [...new Set(keywords(question).map(stem))];
  if (!words.length) return null;
  let best = null;
  for (const s of readmeSections()) {
    let score = 0;
    for (const w of words) {
      const tf = s.tf.get(w) || 0;
      if (tf) score += (1 + Math.log(tf)) * s.idf(w);
    }
    score /= Math.sqrt(s.words.length + 20) / 5;
    // A word in the section's title is the strongest hint of all.
    for (const w of words) if (s.titleWords.has(w)) score += 1.5 * s.idf(w);
    if (!best || score > best.score) best = { section: s, score };
  }
  if (!best || best.score <= 0) return null;
  return { title: best.section.title, excerpt: excerpt(best.section.text, words), score: best.score };
}

// The one or two sentences of a section that mention the most query words.
function excerpt(text, words) {
  const prose = readmeProse(text).replace(/\s+/g, ' ').trim();
  const sents = sentences(prose);
  if (!sents.length) return prose.slice(0, 220);
  const scored = sents.map((s, i) => ({ s, i, hits: words.filter((w) => s.toLowerCase().includes(w)).length }));
  if (!scored.some((x) => x.hits)) return sents.slice(0, 2).join(' ');
  scored.sort((a, b) => b.hits - a.hits || a.i - b.i);
  const top = scored.slice(0, 2).sort((a, b) => a.i - b.i).map((x) => x.s).join(' ');
  return top.length > 320 ? `${top.slice(0, 317).replace(/\s+\S*$/, '')}…` : top;
}

module.exports = { MarkovModel, loadModel, ramble, wellFormed, retrieve, keywords, tokenize, sentences, stem };
