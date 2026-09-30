'use strict';

// mx2's forward pass: a Llama-style transformer (RMSNorm, rotary positions,
// SwiGLU) read from models/mx2.bin (int8 matrices with a float scale per
// row). The hot loops — matrix multiplies and attention — are WebAssembly
// SIMD (src/mx2kernels.c) run by worker threads that take rows as they go,
// so fast and slow cores both stay busy. The caller stays synchronous: it
// hands out a job, does its share, then waits on an Atomics counter. Prompts
// go through in chunks, so each weight row is read once per chunk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, workerData } = require('worker_threads');

const CHUNK = 128; // prompt tokens per pass
const ROWS = 16; // matrix rows per work item

// ctrl slots
const GEN = 0; // bumped for each job
const DONE = 1; // workers finished with this job
const OP = 2; // 1 matmul, 2 attention, 3 quit
const NEXT = 3; // next work item to take
const READY = 4; // workers started
const P = 8; // job parameters from here on

// --- WebAssembly kernels ------------------------------------------------------------

// clang's object file declares an unshared memory; threads need it shared.
function leb(b, at) { let v = 0; let shift = 0; let x; do { x = b[at++]; v += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80); return [v, at]; }
function enc(v) { const out = []; do { let x = v % 128; v = Math.floor(v / 128); if (v) x |= 0x80; out.push(x); } while (v); return out; }

function sharedModule(bytes, maxPages) {
  const out = [...bytes.subarray(0, 8)];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at];
    const [size, body] = leb(bytes, at + 1);
    let content = bytes.subarray(body, body + size);
    if (id === 2) { // imports
      const c = content;
      let [n, p] = leb(c, 0);
      const fresh = enc(n);
      for (let k = 0; k < n; k++) {
        const start = p;
        let len;
        [len, p] = leb(c, p); p += len;
        [len, p] = leb(c, p); p += len;
        const kind = c[p++];
        if (kind === 2) {
          fresh.push(...c.subarray(start, p));
          const flag = c[p++];
          let min;
          [min, p] = leb(c, p);
          if (flag & 1) [, p] = leb(c, p);
          fresh.push(3, ...enc(Math.max(min, 1)), ...enc(maxPages));
          continue;
        }
        if (kind === 0) [, p] = leb(c, p);
        else if (kind === 1) { p++; const f = c[p++]; [, p] = leb(c, p); if (f & 1) [, p] = leb(c, p); }
        else if (kind === 3) p += 2;
        fresh.push(...c.subarray(start, p));
      }
      content = fresh;
    }
    out.push(id, ...enc(content.length), ...content);
    at = body + size;
  }
  return new WebAssembly.Module(Uint8Array.from(out));
}

function kernels(memory, module) {
  const table = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
  return new WebAssembly.Instance(module, { env: { __linear_memory: memory, __indirect_function_table: table } }).exports;
}

// --- jobs (run by the caller and by every worker) --------------------------------------

function matmulJob(c, k) {
  const W = c[P]; const S = c[P + 1]; const rows = c[P + 2]; const cols = c[P + 3];
  const T = c[P + 4]; const X = c[P + 5]; const out = c[P + 6];
  const items = Math.ceil(rows / ROWS);
  for (;;) {
    const item = Atomics.add(c, NEXT, 1);
    if (item >= items) return;
    k.mm(W, S, item * ROWS, Math.min(rows, (item + 1) * ROWS), cols, T, X, out, rows);
  }
}

// Scores and weighted sums are SIMD; the softmax between them is plain JS
// on this thread's own scratch row.
function attentionJob(c, k, F, scratch) {
  const K = c[P]; const V = c[P + 1]; const pos0 = c[P + 2]; const T = c[P + 3];
  const heads = c[P + 4]; const d = c[P + 5]; const Q = c[P + 6]; const out = c[P + 7];
  const hd = d / heads;
  const scale = 1 / Math.sqrt(hd);
  const items = T * heads;
  const s0 = scratch / 4;
  for (;;) {
    const item = Atomics.add(c, NEXT, 1);
    if (item >= items) return;
    const t = Math.floor(item / heads);
    const h = item % heads;
    const n = pos0 + t + 1;
    k.scores(Q + (t * d + h * hd) * 4, K + h * hd * 4, n, d, hd, scale, scratch);
    let max = -Infinity;
    for (let s = 0; s < n; s++) if (F[s0 + s] > max) max = F[s0 + s];
    let sum = 0;
    for (let s = 0; s < n; s++) { const e = Math.exp(F[s0 + s] - max); F[s0 + s] = e; sum += e; }
    for (let s = 0; s < n; s++) F[s0 + s] /= sum;
    k.wsum(scratch, V + h * hd * 4, n, d, hd, out + (t * d + h * hd) * 4);
  }
}

function doJob(c, k, F, scratch) {
  if (c[OP] === 1) matmulJob(c, k);
  else if (c[OP] === 2) attentionJob(c, k, F, scratch);
}

// --- worker ----------------------------------------------------------------------------

if (!isMainThread && workerData && workerData.mx2) {
  const { ctrl, memory, module, scratch } = workerData;
  const c = new Int32Array(ctrl);
  const k = kernels(memory, module);
  const F = new Float32Array(memory.buffer);
  Atomics.add(c, READY, 1);
  Atomics.notify(c, READY);
  let gen = 0;
  for (;;) {
    Atomics.wait(c, GEN, gen);
    gen = Atomics.load(c, GEN);
    if (c[OP] === 3) break;
    doJob(c, k, F, scratch);
    Atomics.add(c, DONE, 1);
    Atomics.notify(c, DONE);
  }
}

// --- the model -------------------------------------------------------------------------

function readModel(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'MXAI') throw new Error('not an mx model');
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen));
  const base = 8 + headerLen + ((4 - ((8 + headerLen) % 4)) % 4);
  const t = {};
  for (const x of header.tensors) {
    const n = x.shape.reduce((a, b) => a * b, 1);
    const start = base + x.offset;
    t[x.name] = x.dtype === 'i8'
      ? { q: buf.subarray(start, start + n), shape: x.shape }
      : { f: new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + n * 4)), shape: x.shape };
  }
  return { config: header.config, meta: header.meta || {}, t };
}

class Model2 {
  constructor(file, { threads = defaultThreads() } = {}) {
    const { config, meta, t } = readModel(file);
    this.config = config;
    this.meta = meta;
    const { d, layers, heads, hidden: h, vocab, ctx } = config;
    const hd = d / heads;
    this.hd = hd;

    // Matrices that share an input sit side by side: q|k|v and gate|up.
    const groups = [['emb.weight']];
    for (let l = 0; l < layers; l++) {
      const p = `blocks.${l}.`;
      groups.push([`${p}wq.weight`, `${p}wk.weight`, `${p}wv.weight`], [`${p}wo.weight`], [`${p}w1.weight`, `${p}w3.weight`], [`${p}w2.weight`]);
    }
    // One shared memory holds everything: weights, scales, activations,
    // the key/value cache and a scratch row per thread.
    let top = 0;
    const alloc = (bytes) => { const at = top; top += Math.ceil(bytes / 16) * 16; return at; };
    let wBytes = 0;
    let rows = 0;
    for (const g of groups) for (const n of g) { wBytes += t[n].q.length; rows += t[n].shape[0]; }
    const W = alloc(wBytes);
    const S = alloc(rows * 4);
    this.off = {
      in: alloc(CHUNK * Math.max(d, h) * 4),
      out: alloc(CHUNK * Math.max(3 * d, 2 * h) * 4),
      q: alloc(CHUNK * d * 4),
      att: alloc(CHUNK * d * 4),
      logits: alloc(vocab * 4),
    };
    this.kv = alloc(2 * layers * ctx * d * 4);
    const scratch = Array.from({ length: threads + 1 }, () => alloc(ctx * 4));
    const pages = Math.ceil(top / 65536);
    this.memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    const module = sharedModule(fs.readFileSync(path.join(__dirname, 'mx2kernels.wasm')), pages);
    this.k = kernels(this.memory, module);
    const buf = this.memory.buffer;
    this.F = new Float32Array(buf);
    const W8 = new Int8Array(buf);
    this.mats = {};
    let wo = W;
    let so = S;
    for (const g of groups) {
      const m = { W: wo, S: so, rows: 0, cols: t[g[0]].shape[1] };
      for (const n of g) {
        W8.set(new Int8Array(t[n].q.buffer, t[n].q.byteOffset, t[n].q.length), wo);
        this.F.set(t[`${n}.scale`].f, so / 4);
        wo += t[n].q.length;
        so += t[n].shape[0] * 4;
        m.rows += t[n].shape[0];
      }
      this.mats[g[0].replace(/\.weight$/, '')] = m;
    }
    this.W8 = W8;
    this.norms = { final: t['norm.weight'].f };
    for (let l = 0; l < layers; l++) this.norms[l] = [t[`blocks.${l}.norm1.weight`].f, t[`blocks.${l}.norm2.weight`].f];

    this.X = new Float32Array(CHUNK * d);
    this.logits = new Float32Array(vocab);
    this.inv = Float32Array.from({ length: hd / 2 }, (_, i) => 1 / 10000 ** ((2 * i) / hd));
    this.scratch = scratch[0];

    const ctrl = new SharedArrayBuffer(64 * 4);
    this.c = new Int32Array(ctrl);
    this.workers = [];
    for (let i = 1; i <= threads; i++) {
      try {
        const w = new Worker(__filename, { workerData: { mx2: true, ctrl, memory: this.memory, module, scratch: scratch[i] } });
        w.unref();
        this.workers.push(w);
      } catch { break; }
    }
    // A worker that doesn't start would stall every job; carry on without.
    const deadline = Date.now() + 5000;
    for (let r; (r = Atomics.load(this.c, READY)) < this.workers.length && Date.now() < deadline;) Atomics.wait(this.c, READY, r, 50);
    if (Atomics.load(this.c, READY) < this.workers.length) this.close();
    this.reset();
  }

  close() {
    if (!this.workers.length) return;
    this.c[OP] = 3;
    Atomics.add(this.c, GEN, 1);
    Atomics.notify(this.c, GEN);
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  reset() { this.pos = 0; }

  run(op, params) {
    const c = this.c;
    c[OP] = op;
    params.forEach((v, i) => { c[P + i] = v; });
    Atomics.store(c, NEXT, 0);
    Atomics.store(c, DONE, 0);
    const n = this.workers.length;
    if (n) { Atomics.add(c, GEN, 1); Atomics.notify(c, GEN); }
    doJob(c, this.k, this.F, this.scratch);
    for (let done; (done = Atomics.load(c, DONE)) < n;) Atomics.wait(c, DONE, done);
  }

  matmul(m, T, x, out) { this.run(1, [m.W, m.S, m.rows, m.cols, T, x, out]); }

  rmsnorm(T, g, out) {
    const { d } = this.config;
    const { X, F } = this;
    const o = out / 4;
    for (let t = 0; t < T; t++) {
      let ss = 0;
      for (let i = 0; i < d; i++) ss += X[t * d + i] * X[t * d + i];
      const inv = 1 / Math.sqrt(ss / d + 1e-5);
      for (let i = 0; i < d; i++) F[o + t * d + i] = X[t * d + i] * inv * g[i];
    }
  }

  // Feeds tokens at the next positions; returns the logits after the last.
  feed(tokens) {
    const { ctx, vocab } = this.config;
    if (this.pos + tokens.length > ctx) throw new Error('context full');
    for (let at = 0; at < tokens.length; at += CHUNK) this.chunk(tokens.slice(at, at + CHUNK), at + CHUNK >= tokens.length);
    const lo = this.off.logits / 4;
    this.logits.set(this.F.subarray(lo, lo + vocab));
    return this.logits;
  }

  step(token) { return this.feed([token]); }

  chunk(tokens, last) {
    const { d, layers, heads, hidden: h, ctx } = this.config;
    const { X, F, W8, off, hd } = this;
    const T = tokens.length;
    const emb = this.mats.emb;
    for (let t = 0; t < T; t++) {
      const wb = emb.W + tokens[t] * d;
      const sc = F[emb.S / 4 + tokens[t]];
      for (let i = 0; i < d; i++) X[t * d + i] = W8[wb + i] * sc;
    }
    // Rotations for these positions.
    const half = hd / 2;
    const cos = new Float32Array(T * half);
    const sin = new Float32Array(T * half);
    for (let t = 0; t < T; t++) {
      for (let i = 0; i < half; i++) {
        const ang = Math.fround((this.pos + t) * this.inv[i]);
        cos[t * half + i] = Math.cos(ang);
        sin[t * half + i] = Math.sin(ang);
      }
    }
    const fo = off.out / 4;
    const fq = off.q / 4;
    const fin = off.in / 4;
    for (let l = 0; l < layers; l++) {
      const p = `blocks.${l}`;
      const K = this.kv + l * ctx * d * 4;
      const V = this.kv + (layers + l) * ctx * d * 4;
      const fk = K / 4;
      const fv = V / 4;
      this.rmsnorm(T, this.norms[l][0], off.in);
      this.matmul(this.mats[`${p}.wq`], T, off.in, off.out);
      for (let t = 0; t < T; t++) {
        const row = fo + t * 3 * d;
        const at = this.pos + t;
        for (let hh = 0; hh < heads; hh++) {
          for (let i = 0; i < half; i++) {
            const cs = cos[t * half + i];
            const sn = sin[t * half + i];
            const j = hh * hd + 2 * i;
            const q1 = F[row + j]; const q2 = F[row + j + 1];
            F[fq + t * d + j] = q1 * cs - q2 * sn;
            F[fq + t * d + j + 1] = q1 * sn + q2 * cs;
            const k1 = F[row + d + j]; const k2 = F[row + d + j + 1];
            F[fk + at * d + j] = k1 * cs - k2 * sn;
            F[fk + at * d + j + 1] = k1 * sn + k2 * cs;
          }
        }
        F.copyWithin(fv + at * d, row + 2 * d, row + 3 * d);
      }
      this.run(2, [K, V, this.pos, T, heads, d, off.q, off.att]);
      this.matmul(this.mats[`${p}.wo`], T, off.att, off.out);
      for (let i = 0; i < T * d; i++) X[i] += F[fo + i];
      this.rmsnorm(T, this.norms[l][1], off.in);
      this.matmul(this.mats[`${p}.w1`], T, off.in, off.out);
      for (let t = 0; t < T; t++) {
        const row = fo + t * 2 * h;
        for (let j = 0; j < h; j++) {
          const g = F[row + j];
          F[fin + t * h + j] = (g / (1 + Math.exp(-g))) * F[row + h + j];
        }
      }
      this.matmul(this.mats[`${p}.w2`], T, off.in, off.out);
      for (let i = 0; i < T * d; i++) X[i] += F[fo + i];
    }
    this.pos += T;
    if (!last) return;
    // Logits for the last token only.
    X.copyWithin(0, (T - 1) * d, T * d);
    this.rmsnorm(1, this.norms.final, off.in);
    this.matmul(emb, 1, off.in, off.logits);
  }
}

function defaultThreads() {
  const env = process.env.MAXSHELL_AI_THREADS;
  if (env !== undefined && env !== '' && Number.isFinite(Number(env))) return Math.max(0, Number(env));
  return Math.max(0, Math.min(3, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1));
}

module.exports = { Model2, readModel };
