'use strict';

// sage image: pictures from a prompt, made on this Mac by Qwen-Image 2.1
// (Alibaba's open image model; 4-bit, run with mflux on MLX). The model is
// in ~/.maxshell/gemma/image; mflux is in Sage's Python. `sage image --lite`
// is Sage Image Lite: Black Forest Labs' FLUX.2 [klein] 4B (4-bit, the
// mflux-community build) in ~/.maxshell/gemma/image-lite — under half the
// size, 4 steps instead of 8, Apache 2.0. With no flag, Sage Image if it's
// set up, else Lite ($MAXSHELL_IMAGE_MODEL=lite picks Lite). A picture is saved
// as a PNG in the current folder, named after the prompt — never over a
// file that's there — and opened in Preview (or shown inline in iTerm2).
//
// Qwen-Image 2.1 is under the Qwen Research License: research and
// evaluation, not commercial use. The images you make are yours.
//
// Job runs a generation as a separate process and reads its progress from a
// file, so the Sage app can show it while you keep chatting. `sage image`
// with no prompt opens the app for image chat: describe a picture, then say
// how to change it — each message edits the latest version (the edit
// pipeline, given that picture), and every version is kept. A picture of
// your own (--edit, /edit, or a file dragged in) can be the starting point.
//
// The image model follows a detailed prompt far better than a short one, so
// first Sage Pro (Sage Lite, for Sage Image Lite; src/sage.py --image-prompt) turns your words into one —
// the subjects, their places, setting, light, framing and style — or, for an
// edit, into a precise instruction of what to change and what to keep. It
// runs before the image model and exits, so the two never share memory.
// --exact (/exact in image chat) draws from your words as they are.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MFLUX = '0.21.0';
// The image models: where each comes from, the mflux commands that run it
// (draw, and edit a picture), and how many steps look finished.
const MODELS = {
  // 8 steps already look finished; on an M3 a step takes ~9 s at 512² and ~20 s at 768².
  // Only the edit pipeline works with this build (the plain qwen-2.1 one
  // makes noise), and it does plain text-to-image too.
  image: {
    key: 'image', label: 'Sage Image', repo: 'OsaurusAI/Qwen-Image-2.1-mflux-4bit', size: '10.6 GB', folder: 'image',
    draw: 'mflux-generate-qwen-2.1-edit', edit: 'mflux-generate-qwen-2.1-edit', parts: ['transformer', 'text_encoder', 'vae'],
    steps: 8, needFree: 35, eta: 'usually a few minutes',
    license: 'Qwen-Image 2.1 — Qwen Research License: research and evaluation, not commercial use.',
  },
  // FLUX.2 [klein] is distilled to 4 steps (guidance stays 1.0, mflux's default).
  lite: {
    key: 'lite', label: 'Sage Image Lite', repo: 'mflux-community/flux2-klein-4b-mflux-q4', size: '4.6 GB', folder: 'image-lite',
    draw: 'mflux-generate-flux2', edit: 'mflux-generate-flux2-edit', parts: ['transformer', 'text_encoder', 'vae', 'tokenizer'],
    steps: 4, needFree: 15, eta: 'about a minute',
    license: 'FLUX.2 [klein] 4B — Apache 2.0: free to use, commercially too.',
  },
};
const REPO = MODELS.image.repo;
const DEFAULTS = { width: 768, height: 768, steps: MODELS.image.steps };

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = (key = 'image') => path.join(base(), MODELS[key].folder);
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(base(), 'venv', 'bin', 'python');
const bin = (key = 'image', editing = false) => process.env.MAXSHELL_IMAGE_BIN
  || path.join(path.dirname(python()), MODELS[key][editing ? 'edit' : 'draw']);
const modelReady = (key) => fs.existsSync(bin(key)) && MODELS[key].parts.every((p) => fs.existsSync(path.join(dir(key), p)));
// ready(): can Sage draw at all; ready('lite'): is that model set up.
const ready = (key) => (key ? modelReady(key) : Object.keys(MODELS).some(modelReady));

// The model for a picture: the one asked for (--lite, $MAXSHELL_IMAGE_MODEL),
// else Sage Image if it's set up, else Lite if that is.
function choose(want) {
  const asked = want || process.env.MAXSHELL_IMAGE_MODEL;
  if (asked && MODELS[asked]) return asked;
  return modelReady('image') || !modelReady('lite') ? 'image' : 'lite';
}

// Options with the model and its steps filled in.
function resolve(o) {
  const model = choose(o.model);
  return { ...o, model, steps: o.steps || MODELS[model].steps };
}

// "a red panda, reading!" → sage-a-red-panda-reading.png, or -2, -3… if taken.
function outputPath(prompt, folder, ext = '.png') {
  const slug = String(prompt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'image';
  let name = `sage-${slug}${ext}`;
  for (let n = 2; fs.existsSync(path.join(folder, name)); n++) name = `sage-${slug}-${n}${ext}`;
  return path.join(folder, name);
}

// The size to work at for a picture of w×h: its shape, the long side `side`,
// in multiples of 32.
function fitSize(w, h, side) {
  const r32 = (v) => Math.max(256, Math.round(v / 32) * 32);
  return w >= h ? { width: r32(side), height: r32((side * h) / w) } : { width: r32((side * w) / h), height: r32(side) };
}

// A picture of yours, ready to edit: a PNG copy in a scratch folder (sips
// reads JPEG, HEIC, TIFF…, and shrinks big photos), never the file itself.
// → { file, source, width, height } or { error }.
function prepare(file, cwd = process.cwd()) {
  const source = path.resolve(cwd, String(file).replace(/^~(?=\/|$)/, os.homedir()));
  let st;
  try { st = fs.statSync(source); } catch { return { error: `there’s no ${file}` }; }
  if (!st.isFile()) return { error: `${file} isn’t a picture` };
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-input-')), 'picture.png');
  const sips = (...args) => spawnSync('sips', args, { encoding: 'utf8' }).status === 0 && fs.existsSync(out);
  if (!sips('-s', 'format', 'png', source, '--out', out)) return { error: `${file} isn’t a picture Sage can read` };
  const dims = () => { const h = fs.readFileSync(out).subarray(0, 24); return [h.readUInt32BE(16), h.readUInt32BE(20)]; };
  let [width, height] = dims();
  if (Math.max(width, height) > 1536 && sips('-Z', '1536', out)) [width, height] = dims(); // only ever smaller
  return { file: out, source, width, height };
}

// Text that is just a path to a picture — what a terminal pastes when a
// file is dragged in: /a/b\ c.png, '/a/b c.png' or "…" — or null.
function droppedPath(text, cwd = process.cwd()) {
  let t = String(text).trim();
  const q = /^(['"])(.*)\1$/.exec(t);
  t = q ? q[2] : t.replace(/\\(.)/g, '$1');
  if (!/\.(png|jpe?g|heic|heif|webp|gif|tiff?|bmp)$/i.test(t)) return null;
  const full = path.resolve(cwd, t.replace(/^~(?=\/|$)/, os.homedir()));
  return fs.existsSync(full) ? full : null;
}

// sage image's options: { prompt, model, width, height, steps, seed, output, open, images } or { error }.
// steps is null unless asked for: each model has its own (resolve fills it in).
// With `chat`, no prompt is fine (it opens image chat).
function parseArgs(args, { chat = false } = {}) {
  const o = { ...DEFAULTS, steps: null, model: null, seed: null, output: null, open: true, images: [], sized: false };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '--size' || a === '-s') {
      const m = /^(\d+)(?:x(\d+))?$/.exec(next() || '');
      if (!m) return { error: 'size is WIDTHxHEIGHT, e.g. 1024x768' };
      o.width = Number(m[1]);
      o.height = Number(m[2] || m[1]);
      o.sized = !!m[2]; // WxH is exact; one number is the long side when editing
    } else if (a === '--edit' || a === '-e') o.images.push(next() || '');
    else if (a === '--steps') o.steps = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '-o' || a === '--output') o.output = next();
    else if (a === '--no-open') o.open = false;
    else if (a === '--exact') o.exact = true;
    else if (a === '--lite') o.model = 'lite';
    else words.push(a);
  }
  o.prompt = words.join(' ').trim();
  if (!o.prompt && !chat) return { error: 'say what to draw: sage image "a red panda reading under a cherry tree"' };
  for (const k of ['width', 'height']) {
    if (!(o[k] >= 256 && o[k] <= 2048)) return { error: 'sizes go from 256 to 2048' };
    o[k] = Math.round(o[k] / 32) * 32; // the model works in multiples of 32
  }
  if (o.steps !== null && !(o.steps >= 1 && o.steps <= 100)) return { error: 'steps go from 1 to 100' };
  if (o.seed !== null && !Number.isInteger(o.seed)) return { error: 'the seed is a whole number' };
  return o;
}

// The mflux command line for a picture.
function argv(opts, out, free = 100) {
  const o = resolve(opts);
  const m = MODELS[o.model];
  const editing = !!(o.images && o.images.length);
  const seed = o.seed ?? Math.floor(Math.random() * 1e9);
  const a = [bin(o.model, editing), '--model', dir(o.model), ...(o.promptFile ? ['--prompt-file', o.promptFile] : ['--prompt', o.prompt]),
    '--width', String(o.width), '--height', String(o.height), '--steps', String(o.steps), '--seed', String(seed),
    '--output', out, '--vae-tiling'];
  if (editing) a.push('--image-paths', ...o.images); // edit these
  if (free < m.needFree) a.push('--low-ram');
  return a;
}

// Progress from mflux's output: { step, total } of its last progress bar.
function progress(text) {
  const all = [...String(text).matchAll(/(\d+)\/(\d+) \[/g)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { step: Number(m[1]), total: Number(m[2]) };
}

// Opens a file in its Mac app (Preview, QuickTime Player) — never in tests
// (MAXSHELL_IMAGE_NO_OPEN).
function openFile(file) {
  if (process.platform !== 'darwin' || process.env.MAXSHELL_IMAGE_NO_OPEN) return false;
  spawnSync('open', [file], { stdio: 'ignore' });
  return true;
}

// Shows a finished picture: inline in terminals that can (iTerm2, WezTerm),
// else in Preview.
function show(file, write) {
  const term = process.env.TERM_PROGRAM || '';
  if (/iTerm|WezTerm/.test(term) && process.stdout.isTTY) {
    const data = fs.readFileSync(file).toString('base64');
    write(`\x1b]1337;File=inline=1;width=40%;preserveAspectRatio=1:${data}\x07\n`);
    return 'inline';
  }
  return openFile(file) ? 'preview' : null;
}

const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// What Sage is asked to write from: the words, and for an edit, what the
// picture shows so far. A video's "edit" is the picture it starts from.
const request = (o, kind = 'image') => JSON.stringify({ prompt: o.prompt, edit: !!(o.images && o.images.length), context: o.context || null, kind, ...(o.seconds && { seconds: o.seconds }) });

// The last thing a failed prompt writer said.
const lastLine = (text) => String(text).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

// A generation running in the background (for the Sage app). With a writer
// (gemma.promptWriter), Sage writes the prompt first. sage video uses it
// too, with its own command line (build), file type, kind, progress parser
// (parse) and steps to run after it (then: argv lists, e.g. adding sound).
class Job {
  constructor(o, folder, { env = process.env, free = 100, writer = null, build = argv, ext = '.png', kind = 'image', parse = progress, then = [] } = {}) {
    if (build === argv) o = resolve(o); // a picture: which model, and its steps
    this.options = o;
    this.writer = writer;
    this.kind = kind;
    this.parse = parse;
    this.out = o.output ? path.resolve(folder, o.output) : outputPath(o.prompt, folder, ext);
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-image-'));
    const at = (name) => path.join(this.tmp, name);
    [this.log, this.exit, this.prompt, this.detailed, this.wrote, this.writerLog] = ['log', 'exit', 'prompt.txt', 'detailed.txt', 'wrote', 'writer.log'].map(at);
    this.started = Date.now();
    fs.writeFileSync(this.prompt, o.prompt); // the image model's prompt, unless Sage writes a better one
    let first = '';
    if (writer) {
      fs.writeFileSync(at('request.json'), request(o, kind));
      first = `${[...writer.cmd, '--image-prompt', at('request.json'), this.detailed].map(quote).join(' ')} > "$WRITERLOG" 2>&1 && cp "$DETAILED" "$PROMPTFILE"; : > "$WROTE"; `;
    }
    const fd = fs.openSync(this.log, 'w');
    const after = then.map((cmd) => ` && ${cmd.map(quote).join(' ')}`).join('');
    const script = `trap "" INT; ${first}"$@"${after}; echo $? > "$EXITFILE"`;
    const [cmd, ...rest] = build({ ...o, promptFile: this.prompt }, this.out, free);
    this.child = spawn('/bin/sh', ['-c', script, 'sh', cmd, ...rest], {
      cwd: folder,
      env: { ...env, ...(writer && writer.env), EXITFILE: this.exit, PROMPTFILE: this.prompt, DETAILED: this.detailed, WROTE: this.wrote, WRITERLOG: this.writerLog, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', fd, fd], detached: true,
    });
    fs.closeSync(fd);
    this.child.unref();
  }

  // { state: 'running' | 'done' | 'failed', phase: 'prompt' | 'draw', step,
  // total, detailed (Sage's prompt), unwritten (why Sage couldn't), error }
  poll() {
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
    const text = read(this.log) || '';
    const p = { step: 0, total: this.options.steps, ...this.parse(text) };
    const finished = fs.existsSync(this.exit);
    const writing = this.writer && !finished && !fs.existsSync(this.wrote);
    const detailed = read(this.detailed);
    const sage = { phase: writing ? 'prompt' : 'draw', detailed: detailed && detailed.trim() };
    if (this.writer && !writing && !detailed) sage.unwritten = lastLine(read(this.writerLog)) || 'Sage didn’t answer';
    if (!finished) return { state: 'running', ...p, ...sage };
    const code = Number(read(this.exit).trim());
    if (code === 0 && fs.existsSync(this.out)) return { state: 'done', ...p, ...sage };
    const lines = text.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !/\d+\/\d+ \[/.test(l));
    return { state: 'failed', ...p, ...sage, error: lines.slice(-2).join(' ') || `exit ${code}` };
  }

  stop() {
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* gone */ }
  }

  cleanup() {
    try { fs.rmSync(this.tmp, { recursive: true, force: true }); } catch { /* fine */ }
  }
}

function wrapText(text, w) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && (line + ' ' + word).length > w) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function setup(key, write, err) {
  const m = MODELS[key];
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
  if (!fs.existsSync(python())) { err('sage image: set Sage up first: sage --setup\n'); return 1; }
  // Both builds run on mflux 0.21 (its qwen-2.1-edit and flux2 pipelines).
  write(`Installing mflux ${MFLUX}…\n`);
  if (!run(python(), ['-m', 'pip', 'install', '-q', `mflux==${MFLUX}`])) { err('sage image: pip install failed\n'); return 1; }
  fs.mkdirSync(dir(key), { recursive: true });
  write(`Downloading ${m.label}: ${m.repo} (${m.size}) into ${dir(key)}…\n`);
  const snap = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(m.repo)}, local_dir='.')\n`;
  // HF_HUB_VERBOSITY: no "set a HF_TOKEN" warning — public models need no account
  if (!run(python(), ['-c', snap], { cwd: dir(key), env: { HF_HUB_VERBOSITY: 'error', ...process.env, HF_HUB_DISABLE_XET: '1' } })) { err('sage image: download failed\n'); return 1; }
  write(`${m.label} can draw now — try: sage image${key === 'lite' ? ' --lite' : ''} "a lighthouse at dusk, oil painting"\n`);
  return 0;
}

const HELP = `sage image — pictures from a prompt, made on your Mac
  sage image                     image chat: describe a picture, then say how to change it
  sage image <prompt>            a ${DEFAULTS.width}×${DEFAULTS.height} PNG here, opened in Preview
  sage image --edit photo.jpg    image chat, starting from your picture
  sage image --edit photo.jpg <prompt>   change your picture (it's kept; the result is a new file)
  sage image --size 1024x768 …   another size (256–2048, multiples of 32; --size 512 with
                                 --edit is the long side, keeping your picture's shape)
  sage image --lite …            Sage Image Lite (FLUX.2 klein 4B): smaller and faster
  sage image --steps 20 …        more steps: finer, slower (default ${MODELS.image.steps}, Lite ${MODELS.lite.steps})
  sage image --seed 7 …          the same seed and prompt make the same picture
  sage image -o name.png …       choose the file name (never over an existing file)
  sage image --no-open …         don't open it
  sage image --exact …           draw from your words as they are (Sage Pro writes a
                                 detailed prompt from them first, by default; for
                                 --lite, Sage Lite does)
  sage image --setup             install it (~${MODELS.image.size})
  sage image --lite --setup      install Sage Image Lite (~${MODELS.lite.size})
Sage Image: ${MODELS.image.license}
Sage Image Lite: ${MODELS.lite.license}
`;

function runImage(args, io, shell) {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  if (args.includes('--setup')) return setup(args.includes('--lite') ? 'lite' : 'image', write, err);
  if (args[0] === '--help' || args[0] === '-h') { write(HELP); return 0; }
  const o = parseArgs(args, { chat: true });
  if (o.error) { err(`sage image: ${o.error}\n`); return 1; }
  o.model = choose(o.model);
  const m = MODELS[o.model];
  const unready = () => {
    if (!ready()) err('sage image: the image model isn’t set up — run: sage image --setup (or --lite --setup for the smaller one)\n');
    else err(`sage image: ${m.label} isn’t set up — run: sage image${o.model === 'lite' ? ' --lite' : ''} --setup\n`);
    return 1;
  };
  if (o.images.length > 1) { err('sage image: one picture at a time\n'); return 1; }
  let mine = null;
  if (o.images.length) {
    mine = prepare(o.images[0], shell.cwd);
    if (mine.error) { err(`sage image: ${mine.error}\n`); return 1; }
    o.images = [mine.file];
    if (!o.sized) Object.assign(o, fitSize(mine.width, mine.height, Math.max(o.width, o.height)));
  }
  if (!o.prompt) {
    if (!(process.stdin.isTTY && process.stdout.isTTY && io.stdout.kind === 'term')) { write(HELP); return 1; }
    if (!ready(o.model)) return unready();
    const sage = require('./sage');
    const tui = require('./tui');
    const free = () => require('./gemma').freeMemory();
    const app = new sage.SageApp({
      mode: 'image', root: shell.cwd, model: 'image', models: [], start: () => sage.IDLE, imageLabel: m.label,
      startImage: (opts) => new Job({ ...opts, model: o.model }, shell.cwd, { env: shell.env, free: free(), writer: opts.exact ? null : require('./gemma').promptWriter(shell, { lite: o.model === 'lite' }) }),
    });
    if (mine) app.load(mine);
    return tui.fullscreen(() => sage.loop(app), { cursor: true, mouse: true });
  }
  if (!ready(o.model)) return unready();
  if (!o.steps) o.steps = m.steps;
  const out = o.output ? path.resolve(shell.cwd, o.output) : outputPath(o.prompt, shell.cwd); // named after your words
  if (fs.existsSync(out)) { err(`sage image: ${o.output} is already there — pick another name\n`); return 1; }
  const muted = theme.style(theme.current().ui.muted);
  const writer = o.exact ? null : require('./gemma').promptWriter(shell, { lite: o.model === 'lite' }); // Lite's prompt: by Sage Lite
  if (writer) { // Sage turns the words into a detailed prompt first
    write(`${muted}✦ ${writer.label} is writing a detailed prompt…${ansi.reset()}\n`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-prompt-'));
    fs.writeFileSync(path.join(tmp, 'request.json'), request(o));
    const [cmd, ...rest] = writer.cmd;
    const r = spawnSync(cmd, [...rest, '--image-prompt', path.join(tmp, 'request.json'), path.join(tmp, 'detailed.txt')], { env: { ...shell.env, ...writer.env }, encoding: 'utf8' });
    let detailed = null;
    try { detailed = fs.readFileSync(path.join(tmp, 'detailed.txt'), 'utf8').trim(); } catch { /* it couldn't */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (detailed) {
      o.prompt = detailed;
      for (const l of wrapText(detailed, Math.max(20, (process.stdout.columns || 80) - 4))) write(`${muted}  ${l}${ansi.reset()}\n`);
    } else write(`${muted}  (${lastLine(r.stderr) || 'Sage didn’t answer'} — drawing from your words)${ansi.reset()}\n`);
  }
  write(`${muted}✦ ${m.label} is ${mine ? 'editing' : 'drawing'} ${o.width}×${o.height}, ${o.steps} steps — ${m.eta}${ansi.reset()}\n`);
  const began = Date.now();
  const free = require('./gemma').freeMemory();
  const status = shell.runExternal(argv(o, out, free), io, { ...shell.env, PYTHONUNBUFFERED: '1' });
  if (status !== 0 || !fs.existsSync(out)) { err('sage image: the picture wasn’t made\n'); return status || 1; }
  const secs = Math.round((Date.now() - began) / 1000);
  const where = path.relative(shell.cwd, out) || out;
  write(`${theme.style(theme.current().ui.ok)}✓${ansi.reset()} saved ${where} ${muted}(${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`})${ansi.reset()}\n`);
  if (o.open && io.stdout.kind === 'term') show(out, write);
  return 0;
}

module.exports = { runImage, Job, parseArgs, outputPath, argv, prepare, fitSize, droppedPath, request, lastLine, wrapText, quote, progress, ready, choose, resolve, show, openFile, dir, MODELS, DEFAULTS, REPO, HELP };
