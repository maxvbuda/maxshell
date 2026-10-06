'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// `ai`: mx, maxshell's on-device language model — a small GPT trained on
// this Mac by ai/train.py. This file runs it with no dependencies: it reads
// the int8 weights in models/mx.bin, tokenizes with the byte-level BPE in
// models/mx-tokenizer.json, and runs the transformer forward pass in plain
// JavaScript with a key/value cache, streaming the reply as it's sampled.

const MODELS = process.env.MAXSHELL_AI_MODEL_DIR || path.join(__dirname, '..', 'models');

// --- tokenizer --------------------------------------------------------------------

class Tokenizer {
  constructor(spec) {
    this.merges = spec.merges;
    this.ranks = new Map(spec.merges.map(([a, b], i) => [`${a},${b}`, i]));
    this.special = spec.specials;
    this.split = new RegExp(spec.split, 'gu');
    this.bytes = [];
    for (let i = 0; i < 256; i++) this.bytes[i] = [i];
    spec.merges.forEach(([a, b], i) => { this.bytes[256 + i] = this.bytes[a].concat(this.bytes[b]); });
    this.cache = new Map();
  }

  encodeChunk(chunk) {
    const hit = this.cache.get(chunk);
    if (hit) return hit;
    let ids = [...Buffer.from(chunk, 'utf8')];
    while (ids.length > 1) {
      let best = -1;
      let at = -1;
      for (let i = 0; i < ids.length - 1; i++) {
        const r = this.ranks.get(`${ids[i]},${ids[i + 1]}`);
        if (r !== undefined && (best === -1 || r < best)) { best = r; at = i; }
      }
      if (best === -1) break;
      ids = [...ids.slice(0, at), 256 + best, ...ids.slice(at + 2)];
    }
    if (this.cache.size < 50000) this.cache.set(chunk, ids);
    return ids;
  }

  encode(text) {
    const out = [];
    for (const m of text.matchAll(this.split)) out.push(...this.encodeChunk(m[0]));
    return out;
  }

  // Bytes for a token (specials have none).
  tokenBytes(id) { return this.bytes[id] || []; }

  decode(ids) {
    return Buffer.from(ids.flatMap((i) => this.tokenBytes(i))).toString('utf8');
  }
}

// --- the model -----------------------------------------------------------------------

function loadWeights(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'MXAI') throw new Error('not an mx model');
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen));
  const base = 8 + headerLen + ((4 - ((8 + headerLen) % 4)) % 4);
  const raw = {};
  for (const t of header.tensors) {
    const n = t.shape.reduce((a, b) => a * b, 1);
    const start = buf.byteOffset + base + t.offset;
    if (t.dtype === 'i8') raw[t.name] = { q: new Int8Array(buf.buffer, start, n), shape: t.shape };
    else raw[t.name] = { f: new Float32Array(buf.buffer.slice(start, start + n * 4)), shape: t.shape };
  }
  // Matrices are dequantized once (int8 × per-row scale) into Float32Arrays.
  const w = {};
  for (const [name, t] of Object.entries(raw)) {
    if (name.endsWith('.scale')) continue;
    if (t.q) {
      const scale = raw[`${name}.scale`].f;
      const [rows, cols] = t.shape;
      const f = new Float32Array(rows * cols);
      for (let r = 0; r < rows; r++) {
        const s = scale[r];
        for (let c = 0; c < cols; c++) f[r * cols + c] = t.q[r * cols + c] * s;
      }
      w[name] = { data: f, shape: t.shape };
    } else w[name] = { data: t.f, shape: t.shape };
  }
  return { config: header.config, meta: header.meta || {}, w };
}

// out = W·x + b, with W stored [rows][cols].
function matvec(out, W, x, b, rows, cols) {
  for (let r = 0; r < rows; r++) {
    let s = b ? b[r] : 0;
    const o = r * cols;
    for (let c = 0; c < cols; c++) s += W[o + c] * x[c];
    out[r] = s;
  }
}

function layerNorm(out, x, g, b, n) {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mean; v += d * d; }
  const inv = 1 / Math.sqrt(v / n + 1e-5);
  for (let i = 0; i < n; i++) out[i] = (x[i] - mean) * inv * g[i] + b[i];
}

const GELU_C = Math.sqrt(2 / Math.PI);
const gelu = (x) => 0.5 * x * (1 + Math.tanh(GELU_C * (x + 0.044715 * x * x * x)));

class Model {
  constructor({ config, meta, w }) {
    this.config = config;
    this.meta = meta;
    this.w = w;
    const { d, vocab } = config;
    this.x = new Float32Array(d);
    this.h = new Float32Array(d);
    this.qkv = new Float32Array(3 * d);
    this.att = new Float32Array(d);
    this.tmp = new Float32Array(d);
    this.ff = new Float32Array(4 * d);
    this.logits = new Float32Array(vocab);
    this.reset();
  }

  reset() {
    const { layers, ctx, d } = this.config;
    this.pos = 0;
    this.k = Array.from({ length: layers }, () => new Float32Array(ctx * d));
    this.v = Array.from({ length: layers }, () => new Float32Array(ctx * d));
  }

  // Feeds one token at the next position; returns the logits for what comes next.
  step(token) {
    const { d, heads, layers, vocab, ctx } = this.config;
    if (this.pos >= ctx) throw new Error('context full');
    const W = (n) => this.w[n].data;
    const x = this.x;
    const wte = W('wte.weight');
    const wpe = W('wpe.weight');
    for (let i = 0; i < d; i++) x[i] = wte[token * d + i] + wpe[this.pos * d + i];
    const hd = d / heads;
    const scale = 1 / Math.sqrt(hd);
    const T = this.pos + 1;
    const scores = new Float32Array(T);

    for (let l = 0; l < layers; l++) {
      const p = `blocks.${l}.`;
      layerNorm(this.h, x, W(`${p}ln1.weight`), W(`${p}ln1.bias`), d);
      matvec(this.qkv, W(`${p}qkv.weight`), this.h, W(`${p}qkv.bias`), 3 * d, d);
      const K = this.k[l];
      const V = this.v[l];
      K.set(this.qkv.subarray(d, 2 * d), this.pos * d);
      V.set(this.qkv.subarray(2 * d, 3 * d), this.pos * d);
      for (let hh = 0; hh < heads; hh++) {
        const qo = hh * hd;
        let max = -Infinity;
        for (let t = 0; t < T; t++) {
          let s = 0;
          const ko = t * d + qo;
          for (let i = 0; i < hd; i++) s += this.qkv[qo + i] * K[ko + i];
          s *= scale;
          scores[t] = s;
          if (s > max) max = s;
        }
        let sum = 0;
        for (let t = 0; t < T; t++) { scores[t] = Math.exp(scores[t] - max); sum += scores[t]; }
        for (let i = 0; i < hd; i++) this.att[qo + i] = 0;
        for (let t = 0; t < T; t++) {
          const a = scores[t] / sum;
          const vo = t * d + qo;
          for (let i = 0; i < hd; i++) this.att[qo + i] += a * V[vo + i];
        }
      }
      matvec(this.tmp, W(`${p}proj.weight`), this.att, W(`${p}proj.bias`), d, d);
      for (let i = 0; i < d; i++) x[i] += this.tmp[i];
      layerNorm(this.h, x, W(`${p}ln2.weight`), W(`${p}ln2.bias`), d);
      matvec(this.ff, W(`${p}fc.weight`), this.h, W(`${p}fc.bias`), 4 * d, d);
      for (let i = 0; i < 4 * d; i++) this.ff[i] = gelu(this.ff[i]);
      matvec(this.tmp, W(`${p}out.weight`), this.ff, W(`${p}out.bias`), d, 4 * d);
      for (let i = 0; i < d; i++) x[i] += this.tmp[i];
    }
    layerNorm(this.h, x, W('ln_f.weight'), W('ln_f.bias'), d);
    matvec(this.logits, wte, this.h, null, vocab, d);
    this.pos++;
    return this.logits;
  }
}

// --- sampling ------------------------------------------------------------------------

function sampleToken(logits, { temperature = 0.7, topK = 40, rand = Math.random, banned = null } = {}) {
  const n = logits.length;
  const idx = [];
  for (let i = 0; i < n; i++) if (!banned || !banned.has(i)) idx.push(i);
  idx.sort((a, b) => logits[b] - logits[a]);
  const top = idx.slice(0, Math.max(1, topK));
  if (temperature <= 0) return top[0];
  const max = logits[top[0]];
  const ps = top.map((i) => Math.exp((logits[i] - max) / temperature));
  const sum = ps.reduce((a, b) => a + b, 0);
  let r = rand() * sum;
  for (let k = 0; k < top.length; k++) { r -= ps[k]; if (r <= 0) return top[k]; }
  return top[top.length - 1];
}

// --- chat ------------------------------------------------------------------------------

let loaded = null;

// Models are shown by version: mx3 is "mx 0.0.3", the original mx "mx 0.0.1".
// Files and folders keep the short names (models/mx3.bin, ai/mx3/).
const versionName = (n) => (n === 'mx' ? 'mx 0.0.1' : String(n).replace(/^mx(\d+)$/, 'mx 0.0.$1'));
// "mx 0.0.3", "0.0.3", "mx0.0.3" or "mx3" → "mx3".
function shortName(s) {
  if (!s) return s;
  const m = /^\s*(?:mx\s*)?0\.0\.(\d+)\s*$/i.exec(s);
  if (!m) return s.trim();
  return m[1] === '1' ? 'mx' : `mx${m[1]}`;
}
// The model calls itself by its old name ("I'm mx3"); say the version instead.
const ownName = (text) => text.replace(/\bmx([2-9])\b/g, 'mx 0.0.$1');

// The newest model that's been trained and exported (mx4, mx3, mx2, then
// the original mx); MAXSHELL_AI picks one.
function modelName() {
  const has = (n) => fs.existsSync(path.join(MODELS, `${n}.bin`)) && fs.existsSync(path.join(MODELS, `${n}-tokenizer.json`));
  const want = shortName(process.env.MAXSHELL_AI);
  if (want && has(want)) return want;
  return ['mx4', 'mx3', 'mx2', 'mx'].find(has) || null;
}

function available() { return modelName() !== null; }

function load() {
  if (loaded) return loaded;
  const name = modelName();
  const tok = new Tokenizer(JSON.parse(fs.readFileSync(path.join(MODELS, `${name}-tokenizer.json`), 'utf8')));
  const file = path.join(MODELS, `${name}.bin`);
  const model = name === 'mx' ? new Model(loadWeights(file)) : new (require('./mx2').Model2)(file);
  loaded = { tok, model, name };
  return loaded;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The context line the model was trained to read: date, time, your name,
// and the calculator's answer when the message is a sum.
function contextLine(now = new Date(), name = null, calc = null) {
  const time = `${((now.getHours() + 11) % 12) + 1}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() < 12 ? 'AM' : 'PM'}`;
  const date = `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  return `date: ${date} · time: ${time}${name ? ` · user: ${name}` : ''}${calc ? ` · calc: ${calc}` : ''}`;
}

// The calculator tool: "what's 7 plus 5" → "7 + 5 = 12". Small models are
// bad at arithmetic, so the runtime does the sum and the model reads it.
function calculate(message) {
  const m = /(-?\d+(?:\.\d+)?)\s*(\+|-|\*|x|×|\/|÷|plus|minus|times|divided by|multiplied by)\s*(-?\d+(?:\.\d+)?)/i.exec(message);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = { '+': '+', plus: '+', '-': '-', minus: '-', '*': '×', x: '×', '×': '×', times: '×', 'multiplied by': '×', '/': '÷', '÷': '÷', 'divided by': '÷' }[m[2].toLowerCase()];
  let v;
  if (op === '+') v = a + b;
  else if (op === '-') v = a - b;
  else if (op === '×') v = a * b;
  else { if (b === 0) return null; v = Math.round((a / b) * 1e6) / 1e6; }
  return `${a} ${op} ${b} = ${v}`;
}

// Tokens for a conversation so far, ending with the AI's turn marker. Old
// turns are dropped when the whole thing wouldn't fit the context.
function promptTokens(tok, sys, turns, room) {
  const S = tok.special;
  const head = [S['<|doc|>'], S['<|sys|>'], ...tok.encode(sys), S['<|end|>']];
  const encTurn = ([who, text]) => [who === 'user' ? S['<|user|>'] : S['<|ai|>'], ...tok.encode(text), S['<|end|>']];
  let body = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = encTurn(turns[i]);
    if (head.length + t.length + body.length + 1 > room) break;
    body = t.concat(body);
  }
  return [...head, ...body, S['<|ai|>']];
}

// --- your name ------------------------------------------------------------------------
// A model this small is bad at copying a name it has seen once in the chat,
// but good at reading one from its context line. So the runtime spots the
// name ("my name is Max", "call me Max", or "Max" right after being asked)
// and puts it there — and a guard fixes a reply that still gets it wrong.

const NOT_NAMES = new Set(('yes no nope nah ok okay sure hi hey hello thanks fine good great bad tired sad happy '
  + 'bored here back sorry what why how who nothing none busy lol haha cool nice well').split(' '));

function nameFrom(turns) {
  let found = null;
  for (let i = 0; i < turns.length; i++) {
    const [who, text] = turns[i];
    if (who !== 'user') continue;
    let m = /\b(?:my name is|my name's|call me|you can call me|i am called|name's)\s+([A-Za-z][A-Za-z'-]{1,20})\b/i.exec(text);
    const asked = i > 0 && turns[i - 1][0] === 'ai' && /what('s| is) your name|what should i call you|your name\?/i.test(turns[i - 1][1]);
    if (!m && asked) m = /^\s*(?:(?:i am|i'm|im|it's|its|it is|this is)\s+)?([A-Za-z][A-Za-z'-]{1,20})[\s.!]*$/i.exec(text);
    if (m && !NOT_NAMES.has(m[1].toLowerCase())) found = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  }
  return found;
}

// "Nice to meet you, Nora!" when you're Max → "Nice to meet you, Max!"
function guardName(text, name) {
  if (!name) return text;
  const other = `(?!${name}\\b)([A-Z][a-z]{1,15})`;
  return text
    .replace(new RegExp(`\\b(Nice to meet you,|Hi|Hey|Hello|Welcome back,|Good (?:morning|afternoon|evening),|You’re|You're|Your name is|Bye,?|Thanks,) ${other}\\b`, 'g'), (m, lead, n) => (NOT_NAMES.has(n.toLowerCase()) ? m : `${lead} ${name}`))
    .replace(new RegExp(`^${other}(,| —)`), (m, n, sep) => (/^(Sure|Here|Good|Easy|Yes|No|Okay|Great|Nice|Press|Run|Open|Type|Hmm|Well|Oh|Ah)$/.test(n) ? m : `${name}${sep}`));
}

// --- is the answer about the question? -------------------------------------------------
// A small model sometimes answers with something it memorized for a
// different question. models/<model>-index.json (ai/make-index.js) maps each
// training answer, by its opening, to the words of the questions it
// answered; a reply whose questions share nothing with yours is a mix-up.

const STOP = new Set(('a an the and or but if then so to of in on at by for with from up down out over into about as is are was were be been '
  + 'am do does did doing have has had i me my mine you your yours we us our they them their he him his she her it its this that these those '
  + 'what which who whom whose when where why how can could would should will shall may might must just very really too also not no yes '
  + 'please pls plz hey hi hello ok okay oh um uh like get got make made want need know tell say said give let lets some any all much many more '
  + 'thing things something anything one there here than now well good whats hows im dont u ur wanna gonna sup yo lol haha hmm yeah yep nah cool nice wow omg idk r').split(' '));

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// The words that carry the meaning; for a message with none ("whats up",
// "how are you") every word counts.
function contentWords(text) {
  const all = (text.toLowerCase().replace(/[’']s\b/g, '').match(/[a-z0-9]+/g) || []);
  const some = all.filter((w) => !STOP.has(w) && w.length > 1).map(stem);
  return [...new Set(some.length ? some : all.filter((w) => !/^(a|an|the)$/.test(w)))];
}

// An answer's opening, with numbers and the person's name taken out.
function answerKey(text, name = null) {
  let t = text;
  if (name) t = t.split(name).join('NAME');
  return t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 40);
}

let indexCache;
function answerIndex() {
  if (indexCache !== undefined) return indexCache;
  indexCache = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(MODELS, `${load().name}-index.json`), 'utf8'));
    indexCache = new Map(Object.entries(raw.answers).map(([k, ids]) => [k, new Set(ids.map((i) => raw.words[i]))]));
  } catch { /* no index: confidence alone decides */ }
  return indexCache;
}

// How well a reply fits the message: 'fits', 'mismatch' (a memorized answer
// to other questions) or 'unknown' (not a memorized answer).
function relevance(message, text, name = null) {
  const index = answerIndex();
  if (!index) return 'unknown';
  // The model sometimes puts its own opener ("Sure! ") on a memorized answer.
  const bare = text.replace(/^(sure|okay|ok|yes|good question|here’s how|no problem|of course)[!.:,]?\s+/i, '');
  let words = index.get(answerKey(text, name)) || index.get(answerKey(bare, name));
  if (!words) {
    // Not a known answer — but maybe a known opening with an invented
    // ending ("It’s a command on your Mac: <made-up>"). Judge it by the
    // questions that opening answered.
    const head = answerKey(text, name).slice(0, 26);
    if (head.length < 26) return 'unknown';
    if (!indexCache.heads) {
      indexCache.heads = new Map();
      for (const [k, ws] of indexCache) {
        const h = k.slice(0, 26);
        if (!indexCache.heads.has(h)) indexCache.heads.set(h, new Set());
        const set = indexCache.heads.get(h);
        if (set.size < 3000) for (const w of ws) set.add(w);
      }
    }
    words = indexCache.heads.get(head);
    if (!words) return 'unknown';
  }
  const mine = contentWords(message);
  if (!mine.length) return 'fits';
  const shared = mine.filter((w) => words.has(w)).length;
  return shared >= Math.min(3, Math.ceil(mine.length * 0.6)) ? 'fits' : 'mismatch';
}

// Generates the reply to a conversation. `onText` receives text as it's
// produced (whole UTF-8 characters only).
// mx3 was also trained to judge answers: after a question and an answer it
// reads "check: does the answer fit?" and says yes or no.
const CHECK = 'check: does the answer fit?';
const hasChecker = () => load().name === 'mx3' || !!load().model.meta.checker;

// The model's own verdict on the answer it has written so far: the
// probability of "yes". The check is fed after the answer and then rewound
// (positions past `pos` are simply overwritten), so writing can continue.
function selfCheck(tok, model, logits) {
  const S = tok.special;
  const seq = [S['<|end|>'], S['<|sys|>'], ...tok.encode(CHECK), S['<|end|>'], S['<|ai|>']];
  const at = model.pos;
  if (at + seq.length > model.config.ctx) return 1;
  const saved = Float32Array.from(logits);
  const l = model.feed(seq);
  const yes = l[tok.encode('yes')[0]];
  const no = l[tok.encode('no')[0]];
  model.pos = at;
  logits.set(saved);
  return 1 / (1 + Math.exp(no - yes));
}

// mx2 and mx3 can answer at length (whole programs and websites), so they get
// most of the context for the reply; `stop()` is polled to cut an answer
// short. With `check: n` (mx3), the answer is judged after n tokens and at
// the end, and nothing reaches `onText` until it has passed; a failed check
// stops writing and sets info.rejected.
function reply(turns, { name = null, now = new Date(), temperature = 0.7, topK = 40, maxTokens = null, rand = Math.random, onText = null, stop = null, info = null, check = 0 } = {}) {
  const { tok, model } = load();
  const S = tok.special;
  const ctx = model.config.ctx;
  const big = !!model.feed;
  if (maxTokens === null) maxTokens = big ? ctx : 120;
  const last = turns.length ? turns[turns.length - 1][1] : '';
  name = nameFrom(turns) || name;
  const prompt = promptTokens(tok, contextLine(now, name, calculate(last)), turns, ctx - (big ? Math.min(maxTokens, 1024) : Math.min(maxTokens, 96)));
  model.reset();
  let logits;
  if (big) logits = model.feed(prompt);
  else for (const t of prompt) logits = model.step(t);
  // Special tokens other than <|end|> never belong in a reply.
  const banned = new Set(Object.entries(S).filter(([k]) => k !== '<|end|>').map(([, v]) => v));
  const out = [];
  let pending = [];
  let text = '';
  // Until the answer passes its check, what's written is held back.
  let approved = !check;
  let held = '';
  const emit = (piece) => {
    if (!onText) return;
    if (approved) onText(piece);
    else held += piece;
  };
  const judge = () => {
    const p = selfCheck(tok, model, logits);
    if (info) info.check = Math.min(info.check ?? 1, p);
    if (p < 0.5) { if (info) info.rejected = true; return false; }
    approved = true;
    if (held && onText) onText(held);
    held = '';
    return true;
  };
  const flush = (final) => {
    const bytes = Buffer.from(pending);
    // Hold back an incomplete UTF-8 sequence at the end.
    let cut = bytes.length;
    if (!final) {
      for (let back = 1; back <= Math.min(3, bytes.length); back++) {
        const b = bytes[bytes.length - back];
        if ((b & 0xc0) === 0xc0) { const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2; if (back < need) cut = bytes.length - back; break; }
        if ((b & 0x80) === 0) break;
      }
    }
    const piece = bytes.subarray(0, cut).toString('utf8');
    pending = [...bytes.subarray(cut)];
    if (piece) { text += piece; emit(piece); }
  };
  for (let i = 0; i < maxTokens && model.pos < ctx; i++) {
    if (stop && i % 4 === 0 && stop()) break;
    const next = sampleToken(logits, { temperature, topK, rand, banned });
    if (info) {
      // How sure the model was of each token it wrote (log-probability).
      let max = -Infinity;
      for (let k = 0; k < logits.length; k++) if (logits[k] > max) max = logits[k];
      let sum = 0;
      for (let k = 0; k < logits.length; k++) sum += Math.exp(logits[k] - max);
      (info.logprobs = info.logprobs || []).push(logits[next] - max - Math.log(sum));
    }
    if (next === S['<|end|>']) break;
    out.push(next);
    pending.push(...tok.tokenBytes(next));
    flush(false);
    if (model.pos >= ctx) break;
    logits = model.step(next);
    if (!approved && out.length === check && !judge()) return guardName(text.trim(), name);
  }
  flush(true);
  if (!approved && !judge()) return guardName(text.trim(), name);
  return guardName(text.trim(), name);
}

// --- a reply worth showing --------------------------------------------------------------
// The most likely answer first, then a few sampled ones; the first that fits
// the message wins. If none does, bot's rules get a go (when one really
// matches), and otherwise mx says it didn't follow rather than make
// something up.

const HONEST = [
  (topic) => `I’m not sure I understood${topic ? ` “${topic}”` : ' that'} — I’m a small model and only know some things well. Could you put it another way?`,
  (topic) => `Hmm, I don’t really know about${topic ? ` “${topic}”` : ' that'}, and I’d rather not make something up. 🤷`,
  (topic) => `I didn’t quite follow${topic ? ` “${topic}”` : ''}. I’m good at how-tos on your Mac, maxshell and its commands, simple facts and maths, the time, and a chat.`,
];

function meanLogprob(info) {
  const lp = info.logprobs || [];
  return lp.length ? lp.reduce((a, b) => a + b, 0) / lp.length : 0;
}

function checkedReply(turns, opts = {}) {
  const { shell = null, rand = Math.random } = opts;
  const name = nameFrom(turns) || opts.name || null;
  // A name isn't a topic: "Max" (answering "what's your name?") is small talk.
  let message = turns.length ? turns[turns.length - 1][1] : '';
  if (name && nameFrom(turns.slice(0, -1)) !== name) message = ''; // they just introduced themselves
  else if (name) message = message.replace(new RegExp(`\\b${name}\\b`, 'gi'), ' ');
  const big = !!load().model.feed;
  const why = [];
  if (hasChecker()) {
    // mx3 judges its own answers (the opening first, so a long answer that
    // starts wrong is dropped early and nothing of it is shown).
    for (const temperature of [0, 0.6, 0.8]) {
      const info = {};
      const text = reply(turns, { ...opts, temperature, info, check: 40 });
      const conf = meanLogprob(info);
      why.push(`check ${(info.check ?? 1).toFixed(2)} ${conf.toFixed(2)}`);
      // The word-match index too: mx3's checker can pass a memorized answer
      // to a different question (a made-up word → a command's man summary).
      // (Code answers are left to the checker: their openings are shared
      // by many tasks, so the word match misjudges them.)
      const fit = text.includes('```') ? 'code' : relevance(message, text, name);
      why[why.length - 1] += ` ${fit}`;
      if (!info.rejected && text && conf > -1.5 && fit !== 'mismatch') return { text, source: 'model', why };
      if (opts.stop && opts.stop()) return { text, source: 'model', why };
    }
    return fallbackReply(message, name, shell, rand, why);
  }
  const tries = big ? [0, 0.5] : [0, 0.6, 0.8, 0.8];
  for (const temperature of tries) {
    const info = {};
    const text = reply(turns, { ...opts, temperature, info });
    const fit = relevance(message, text, name);
    const conf = meanLogprob(info);
    why.push(`${fit} ${conf.toFixed(2)}`);
    // New text (code, sums, things mx2 composes) is fine when it's confident.
    if (text && conf > -0.6 && (fit === 'fits' || (fit === 'unknown' && big && conf > -0.25))) return { text, source: 'model', why };
  }
  return fallbackReply(message, name, shell, rand, why);
}

// No answer passed: bot's rules (when one really matches), small talk, or an
// honest "I didn't follow".
function fallbackReply(message, name, shell, rand, why) {
  try {
    const bot = require('./bot');
    const mem = { name };
    const text = bot.reply(message, shell, mem);
    // bot's own identity and games aren't mx's.
    if (mem.last && !/^(fallback|expected|game|identity|name|help)$/.test(mem.last.name) && !text.includes('\n') && !/\bbot\b|💭/i.test(text)) return { text, source: 'bot', why };
  } catch { /* bot's rules need things we don't have here */ }
  // Small talk with no topic ("whats up") gets small talk back.
  const meaningful = (message.toLowerCase().replace(/[’']s\b/g, '').match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && w.length > 1);
  if (!meaningful.length) {
    const chat = ['Not much — just here in your terminal. 😊 What’s up with you?', 'I’m here! Ask me a how-to, a command, a fact, or just chat. 🙂', 'All good on my side! What can I do for you?'];
    return { text: chat[Math.floor(rand() * chat.length)], source: 'chat', why };
  }
  // Name the topic when it's a few plain words ("albert einstein").
  const words = (message.toLowerCase().replace(/[’']s\b/g, '').match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && !/^(write|explain|fix|show|help|was|tell|old|best)$/.test(w));
  const topic = words.length && words.length <= 3 && !/[`"(){};=<>]/.test(message) ? words.join(' ') : '';
  return { text: HONEST[Math.floor(rand() * HONEST.length)](topic), source: 'honest', why };
}

// --- training progress -------------------------------------------------------------------

// Reads a train.log: steps, losses, validation checks, samples. The newest
// run's log is used (mx3, mx2 or the original mx).
function trainingLog() {
  const dir = path.join(__dirname, '..', 'ai');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^mx\d+$/.test(n)); } catch { /* no ai folder */ }
  const logs = [...names, '.'].map((n) => path.join(dir, n, 'data', 'train.log')).filter((f) => fs.existsSync(f));
  logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return logs[0] || path.join(__dirname, '..', 'ai', 'data', 'train.log');
}

// When the run last showed signs of life: a log line, or its checkpoint
// (saved every 15 minutes, even between log lines).
function lastSign(logFile) {
  const ckpt = path.join(path.dirname(logFile), 'ckpt.pt');
  return Math.max(fs.statSync(logFile).mtimeMs, fs.existsSync(ckpt) ? fs.statSync(ckpt).mtimeMs : 0);
}

function trainingStatus(logFile = trainingLog()) {
  let text;
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { return null; }
  // A two-stage run (code, then chat) is reported one stage at a time.
  const stages = text.split(/^=== stage 1 finished.*$/m);
  const stage = stages.length > 1 ? 2 : null;
  text = stages[stages.length - 1];
  const steps = [...text.matchAll(/^step\s+(\d+)\s+loss ([\d.]+)\s+lr ([\d.e+-]+)\s+([\d.]+) min/gm)]
    .map((m) => ({ step: +m[1], loss: +m[2], lr: +m[3], min: +m[4] }));
  const vals = [...text.matchAll(/validation loss ([\d.]+)/g)].map((m) => +m[1]);
  // The latest run line: a schedule extended mid-run logs a new one.
  const total = Number(([...text.matchAll(/--steps (\d+)/g)].pop() || [])[1]) || 5000;
  const params = (/model: ([\d.]+)M parameters/.exec(text) || [])[1];
  const tokens = (/([\d.]+)M training tokens/.exec(text) || [])[1];
  const samples = [];
  const lastBlock = text.lastIndexOf('validation loss');
  if (lastBlock >= 0) {
    for (const m of text.slice(lastBlock).matchAll(/^\s+'(.*?)'\s+→ '(.*)'$/gm)) samples.push([m[1], m[2]]);
  }
  const done = /exported [\d.]+ MB|^done — exported/m.test(text);
  // Sleep and wake, from sleepwatch: paused if the last event is a sleep with
  // no training output after it.
  const events = [...text.matchAll(/^\s+([⏸▶]) (.*?) \((\d\d:\d\d)\)$/gm)];
  const lastEvent = events.length ? events[events.length - 1] : null;
  const asleep = !!lastEvent && lastEvent[1] === '⏸' && !/^step\s/m.test(text.slice(lastEvent.index));
  const sleeps = events.filter((e) => e[1] === '⏸').length;
  return { stage, steps, vals, total, params, tokens, samples, done, asleep, sleeps, lastEvent: lastEvent && `${lastEvent[1]} ${lastEvent[2]} at ${lastEvent[3]}`,
    service: serviceRunning(), mtime: lastSign(logFile) };
}

// 514 → "8 hours 34 minutes"; 3000 → "2 days 2 hours"; 12000 → "1 week 1 day".
function duration(minutes) {
  const units = [['week', 7 * 24 * 60], ['day', 24 * 60], ['hour', 60], ['minute', 1]];
  if (minutes < 1) return 'less than a minute';
  const parts = [];
  let rest = Math.round(minutes);
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (!n) continue;
    parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
    rest -= n * size;
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

function showStatus(write, t, ansi) {
  const st = trainingStatus();
  if (!st || !st.steps.length) { write('No training run found yet. Start one with: ai --train start\n'); return 1; }
  const R = ansi.reset();
  const mu = (s) => `${ansi.fg(t.ui.muted)}${s}${R}`;
  const last = st.steps[st.steps.length - 1];
  const pct = Math.min(1, (last.step + 1) / st.total);
  const { meter } = require('./tui');
  // Pace from the last few reports, so time the Mac spent asleep doesn't count.
  // The median minutes-per-step of the last reports: sleep and evaluation
  // pauses are outliers and don't count.
  const recent = st.steps.slice(-10);
  const rates = [];
  for (let i = 1; i < recent.length; i++) {
    const ds = recent[i].step - recent[i - 1].step;
    if (ds > 0) rates.push((recent[i].min - recent[i - 1].min) / ds);
  }
  rates.sort((a, b) => a - b);
  const rate = rates.length ? rates[Math.floor(rates.length / 2)] : null;
  // The last stage (full-length examples) takes about twice as long a step.
  let phase1 = st.total;
  try {
    const name = (/ai\/(mx\d+)\//.exec(trainingLog()) || [])[1];
    phase1 = Number((/--phase1 (\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', 'ai', name, 'train.args'), 'utf8')) || [])[1]) || st.total;
  } catch { /* no schedule file: one pace throughout */ }
  const longSteps = Math.max(0, st.total - Math.max(phase1, last.step));
  const shortSteps = Math.max(0, Math.min(phase1, st.total) - last.step);
  const longRate = last.step >= phase1 ? 1 : 2;
  const left = rate ? Math.round(shortSteps * rate + longSteps * rate * longRate) : null;
  // Steps are logged every 50, so a slow run is quiet for a while between
  // lines; checkpoints are saved every 15 minutes.
  const stale = Date.now() - st.mtime > Math.max(20, (rate || 0) * 50 * 1.5) * 60 * 1000;
  const state = st.done ? `${ansi.fg(t.ui.ok)}finished${R}`
    : st.asleep && /memory/.test(st.lastEvent) ? `${ansi.fg(t.ui.warn)}paused — the Mac is low on memory; progress saved, resumes when there's room${R}`
    : st.asleep ? `${ansi.fg(t.ui.warn)}paused while the Mac slept — progress saved, resumes on wake${R}`
      : stale ? `${ansi.fg(t.ui.warn)}${st.service ? 'paused' : 'stopped'} (no update for ${Math.round((Date.now() - st.mtime) / 60000)} min)${R}`
        : `${ansi.fg(t.ui.ok)}running${R}`;
  const name = (/ai\/(mx\d+)\//.exec(trainingLog()) || [, 'mx'])[1];
  let stage = st.stage ? mu(` · stage ${st.stage} of 2`) : '';
  if (!st.stage && fs.existsSync(path.join(path.dirname(trainingLog()), '..', 'train2.args'))) stage = mu(' · stage 1 of 2');
  write(`${ansi.bold()}${versionName(name)} training${R}${stage}  ${state}\n`);
  write(`  ${meter(pct, 30)} step ${last.step.toLocaleString()} of ${st.total.toLocaleString()} (${Math.round(pct * 100)}%)${left !== null && !st.done ? mu(`  about ${duration(left)} to go`) : ''}\n`);
  if (st.params) write(`  model     ${st.params}M parameters, trained on ${st.tokens || '?'}M tokens\n`);
  const trend = st.steps.filter((_, i) => i % Math.max(1, Math.floor(st.steps.length / 12)) === 0).map((s) => s.loss);
  const bars = '▁▂▃▄▅▆▇█';
  const hi = Math.max(...trend);
  const lo = Math.min(...trend);
  write(`  loss      ${last.loss.toFixed(3)} now  ${mu(trend.map((v) => bars[Math.round(((v - lo) / (hi - lo || 1)) * 7)]).join(''))}  ${mu(`started at ${st.steps[0].loss.toFixed(2)}`)}\n`);
  if (st.vals.length) write(`  held out  ${st.vals[st.vals.length - 1].toFixed(3)} validation loss ${mu(`(${st.vals.map((v) => v.toFixed(2)).join(' → ')})`)}\n`);
  write(`  lr        ${last.lr.toExponential(2)}\n`);
  if (st.lastEvent) write(`  sleep     ${st.sleeps} pause${st.sleeps === 1 ? '' : 's'} so far ${mu(`(last: ${st.lastEvent})`)}\n`);
  if (!st.done) write(mu(`  ${st.service ? 'runs as a background service: survives sleep and restarts; stop with ai --train stop' : 'not running as a service — start with ai --train start'}\n`));
  if (st.samples.length) {
    write(`  ${mu('latest samples:')}\n`);
    for (const [q, a] of st.samples) write(`    ${q.padEnd(30)} ${mu('→')} ${a}\n`);
  }
  return 0;
}

// --- training as a background service -----------------------------------------------------
//
// A LaunchAgent runs ai/mx2/run-training.sh: it starts at login, restarts
// if training stops for any reason, and the script makes training save and
// pause around sleep. Everything resumes from the last checkpoint.

const SERVICE = 'com.maxshell.mx2-train';
const agentFile = () => path.join(process.env.MAXSHELL_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents'), `${SERVICE}.plist`);

function servicePlist(root = path.join(__dirname, '..'), name = 'mx3') {
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${esc(path.join(root, 'ai', 'mx2', 'run-training.sh'))}</string><string>${name}</string></array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${esc(path.join(root, 'ai', name, 'data', 'service.err'))}</string>
</dict>
</plist>
`;
}

function serviceRunning() {
  if (!fs.existsSync(agentFile())) return false;
  const r = require('child_process').spawnSync('launchctl', ['print', `gui/${process.getuid()}/${SERVICE}`], { encoding: 'utf8' });
  return r.status === 0 && /state = running/.test(r.stdout);
}

function trainService(action, write, err, name = 'mx3') {
  name = shortName(name);
  const { spawnSync } = require('child_process');
  const domain = `gui/${process.getuid()}`;
  const file = agentFile();
  if (action === 'start') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!/^mx\d+$/.test(name) || !fs.existsSync(path.join(__dirname, '..', 'ai', name, 'data', 'chat.jsonl'))) {
      err(`ai: no training data for ${versionName(name)} (build it with node ai/${name}/make-corpus.js)\n`);
      return 1;
    }
    fs.writeFileSync(file, servicePlist(undefined, name));
    spawnSync('launchctl', ['bootout', `${domain}/${SERVICE}`], { stdio: 'ignore' });
    // A run that's still saving keeps the service registered for a few
    // seconds; starting before it's gone fails with an I/O error.
    const gone = () => spawnSync('launchctl', ['print', `${domain}/${SERVICE}`], { stdio: 'ignore' }).status !== 0;
    for (let i = 0; i < 60 && !gone(); i++) spawnSync('sleep', ['1']);
    const r = spawnSync('launchctl', ['bootstrap', domain, file], { encoding: 'utf8' });
    if (r.status !== 0) { err(`ai: couldn't start the training service: ${(r.stderr || '').trim()}\n`); return 1; }
    write(`${versionName(name)} training is running in the background.\n`
      + '  • Closing the lid or sleeping saves progress and pauses; it continues when the Mac wakes.\n'
      + '  • If the Mac restarts or training stops, it starts again and picks up where it left off.\n'
      + '  • Watch it with ai --status; stop it for good with ai --train stop.\n');
    return 0;
  }
  if (action === 'stop') {
    // bootout sends SIGTERM: the trainer saves a checkpoint before it exits.
    spawnSync('launchctl', ['bootout', `${domain}/${SERVICE}`], { stdio: 'ignore' });
    try { fs.unlinkSync(file); } catch { /* wasn't installed */ }
    write('Training stopped (progress is saved). Start again with ai --train start.\n');
    return 0;
  }
  err('usage: ai --train start [0.0.3|0.0.4] | stop\n');
  return 2;
}

// Ctrl-C or Esc while an answer is being written: the terminal goes raw
// and a non-blocking /dev/tty is polled between tokens.
function interruptWatch() {
  const none = { hit: () => false, done() {} };
  if (!process.stdin.isTTY) return none;
  let fd;
  try {
    fd = fs.openSync('/dev/tty', fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    process.stdin.setRawMode(true);
  } catch { if (fd !== undefined) fs.closeSync(fd); return none; }
  const buf = Buffer.alloc(64);
  let stopped = false;
  return {
    hit() {
      if (stopped || fd === null) return stopped;
      try {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n > 0 && (buf.subarray(0, n).includes(3) || buf[0] === 0x1b)) stopped = true;
      } catch { /* EAGAIN: nothing typed */ }
      return stopped;
    },
    done() {
      if (fd === null) return;
      try { process.stdin.setRawMode(false); } catch { /* not a tty any more */ }
      fs.closeSync(fd);
      fd = null;
    },
  };
}

// --- the `ai` command ---------------------------------------------------------------------

function runAi(args, io, shell) {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const t = theme.current();
  const R = ansi.reset();
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  if (args[0] === '--status' || args[0] === '--training') return showStatus(write, t, ansi);
  if (args[0] === '--train') return trainService(args[1], write, err, args[2]);
  if (args[0] === '--info') {
    if (!available()) { err('ai: no model yet — train one with: python3 ai/train.py\n'); return 1; }
    const { model } = load();
    const m = model.meta;
    write(`${versionName(load().name)} — ${((m.params || 0) / 1e6).toFixed(1)}M parameters, ${model.config.layers} layers × ${model.config.d} wide, `
      + `${model.config.ctx}-token context, trained ${m.trained || '?'} on ${m.device || '?'} (${m.steps || '?'} steps, validation loss ${m.val_loss ?? '?'})\n`);
    return 0;
  }
  if (!available()) {
    err('ai: the model isn’t trained yet. Run:  node ai/make-dataset.js && python3 ai/train.py\n');
    return 1;
  }
  let name = null;
  try {
    const saved = JSON.parse(fs.readFileSync(process.env.MAXSHELL_BOT_FILE || path.join(os.homedir(), '.maxshell_bot'), 'utf8'));
    name = saved.name || null;
  } catch { /* nobody introduced yet */ }
  const tag = `${ansi.fg(t.ui.accent)}${ansi.bold()}✨ ai ❯${R} `;
  const youTag = `${ansi.fg(t.ui.accent2)}${ansi.bold()}you ❯${R} `;
  const memoryFile = process.env.MAXSHELL_BOT_FILE || path.join(os.homedir(), '.maxshell_bot');
  // The whole reply is checked (the name guard) before it's shown.
  const answer = (turns) => {
    const told = nameFrom(turns);
    if (told && told !== name) {
      name = told;
      // Shared with `bot`, so both remember you.
      try {
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(memoryFile, 'utf8')); } catch { /* new */ }
        fs.writeFileSync(memoryFile, `${JSON.stringify({ ...saved, name }, null, 2)}\n`);
      } catch { /* can't save; still used for this chat */ }
    }
    write(`${tag}${ansi.fg(t.ui.muted)}…${R}`);
    if (!load().model.feed) {
      const text = ownName(checkedReply(turns, { name, shell }).text);
      write(`\r\x1b[K${tag}${text}\n`);
      return text;
    }
    // mx2 answers can be long, so they stream. The opening is held back
    // until its first line is done so the name guard can check it; code
    // blocks are coloured; Ctrl-C or Esc stops the answer.
    const code = theme.style(t.syntax.code);
    let started = false;
    let head = '';
    let inCode = false;
    let line = '';
    const show = (piece) => {
      for (const ch of piece) {
        if (ch === '\n') {
          write(`${R}\n`);
          if (/^\s*```/.test(line)) inCode = !inCode;
          line = '';
          continue;
        }
        if (!line && inCode) write(code);
        line += ch;
        write(ch);
      }
    };
    const onText = (piece) => {
      if (!started) {
        head += piece;
        if (!head.includes('\n') && head.length < 120) return;
        started = true;
        write(`\r\x1b[K${tag}`);
        show(ownName(guardName(head.replace(/^\s+/, ''), name)));
        return;
      }
      show(piece);
    };
    const keys = interruptWatch();
    let text;
    try { text = checkedReply(turns, { name, shell, onText, stop: keys.hit }).text; } finally { keys.done(); }
    if (!started) write(`\r\x1b[K${tag}${ownName(text)}`);
    write(`${R}${keys.hit() ? `${ansi.fg(t.ui.muted)} (stopped)${R}` : ''}\n`);
    return text;
  };

  if (args.length) {
    answer([['user', args.join(' ')]]);
    return 0;
  }
  const intro = { mx4: 'mx 0.0.4, an AI running on this Mac — good at conversation, code and simple games. Ctrl-C stops an answer.', mx3: 'mx 0.0.3, an AI running on this Mac — good at code, websites and explaining things. Ctrl-C stops an answer.', mx2: 'mx 0.0.2, an AI running on this Mac — good at code and websites. Ctrl-C stops an answer.' }[load().name] || `${versionName(load().name)}, a small AI running on this Mac.`;
  write(`${ansi.fg(t.ui.muted)}${intro} It can be wrong — double-check anything important. bye to leave.${R}\n`);
  const turns = [];
  for (;;) {
    write(youTag);
    const line = shell.readLine(io.stdin);
    if (line === null) { write('\n'); return 0; }
    if (/^\s*(bye|exit|quit|goodbye)\s*[.!]*$/i.test(line)) { write(`${tag}Bye! 👋\n`); return 0; }
    if (!line.trim()) continue;
    turns.push(['user', line.trim()]);
    turns.push(['ai', answer(turns)]);
  }
}

module.exports = {
  Tokenizer, Model, loadWeights, sampleToken, promptTokens, contextLine, calculate, nameFrom, guardName, reply, runAi, available,
  load, trainingStatus, servicePlist, duration, contentWords, answerKey, relevance, checkedReply, versionName, shortName, ownName,
};
