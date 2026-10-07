'use strict';

// sage image: pictures from a prompt, made on this Mac by Qwen-Image 2.1
// (Alibaba's open image model; 4-bit, run with mflux on MLX). The model is
// in ~/.maxshell/gemma/image; mflux is in Sage's Python. A picture is saved
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
// pipeline, given that picture), and every version is kept.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = 'OsaurusAI/Qwen-Image-2.1-mflux-4bit';
const MFLUX = '0.21.0';
const SIZE = '10.6 GB';
const PARTS = ['transformer', 'text_encoder', 'vae'];
// 8 steps already look finished; on an M3 a step takes ~9 s at 512² and ~20 s at 768².
const DEFAULTS = { width: 768, height: 768, steps: 8 };
const NEED_FREE = 35; // % of memory free; below it, mflux's low-RAM mode

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = () => path.join(base(), 'image');
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(base(), 'venv', 'bin', 'python');
// The edit pipeline: it also does plain text-to-image, and it's the one this
// build is made for (the plain qwen-2.1 pipeline makes only noise with it).
const bin = () => process.env.MAXSHELL_IMAGE_BIN || path.join(path.dirname(python()), 'mflux-generate-qwen-2.1-edit');
const ready = () => fs.existsSync(bin()) && PARTS.every((p) => fs.existsSync(path.join(dir(), p)));

// "a red panda, reading!" → sage-a-red-panda-reading.png, or -2, -3… if taken.
function outputPath(prompt, folder) {
  const slug = String(prompt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'image';
  let name = `sage-${slug}.png`;
  for (let n = 2; fs.existsSync(path.join(folder, name)); n++) name = `sage-${slug}-${n}.png`;
  return path.join(folder, name);
}

// sage image's options: { prompt, width, height, steps, seed, output, open } or { error }.
function parseArgs(args) {
  const o = { ...DEFAULTS, seed: null, output: null, open: true };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '--size' || a === '-s') {
      const m = /^(\d+)(?:x(\d+))?$/.exec(next() || '');
      if (!m) return { error: 'size is WIDTHxHEIGHT, e.g. 1024x768' };
      o.width = Number(m[1]);
      o.height = Number(m[2] || m[1]);
    } else if (a === '--steps') o.steps = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '-o' || a === '--output') o.output = next();
    else if (a === '--no-open') o.open = false;
    else words.push(a);
  }
  o.prompt = words.join(' ').trim();
  if (!o.prompt) return { error: 'say what to draw: sage image "a red panda reading under a cherry tree"' };
  for (const k of ['width', 'height']) {
    if (!(o[k] >= 256 && o[k] <= 2048)) return { error: 'sizes go from 256 to 2048' };
    o[k] = Math.round(o[k] / 32) * 32; // the model works in multiples of 32
  }
  if (!(o.steps >= 1 && o.steps <= 100)) return { error: 'steps go from 1 to 100' };
  if (o.seed !== null && !Number.isInteger(o.seed)) return { error: 'the seed is a whole number' };
  return o;
}

// The mflux command line for a picture.
function argv(o, out, free = 100) {
  const seed = o.seed ?? Math.floor(Math.random() * 1e9);
  const a = [bin(), '--model', dir(), '--prompt', o.prompt,
    '--width', String(o.width), '--height', String(o.height), '--steps', String(o.steps), '--seed', String(seed),
    '--output', out, '--vae-tiling'];
  if (o.images && o.images.length) a.push('--image-paths', ...o.images); // edit these
  if (free < NEED_FREE) a.push('--low-ram');
  return a;
}

// Progress from mflux's output: { step, total } of its last progress bar.
function progress(text) {
  const all = [...String(text).matchAll(/(\d+)\/(\d+) \[/g)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { step: Number(m[1]), total: Number(m[2]) };
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
  if (process.platform === 'darwin' && !process.env.MAXSHELL_IMAGE_NO_OPEN) {
    spawnSync('open', [file], { stdio: 'ignore' });
    return 'preview';
  }
  return null;
}

// A generation running in the background (for the Sage app).
class Job {
  constructor(o, folder, { env = process.env, free = 100 } = {}) {
    this.options = o;
    this.out = o.output ? path.resolve(folder, o.output) : outputPath(o.prompt, folder);
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-image-'));
    this.log = path.join(this.tmp, 'log');
    this.exit = path.join(this.tmp, 'exit');
    this.started = Date.now();
    const fd = fs.openSync(this.log, 'w');
    const script = 'trap "" INT; "$@"; echo $? > "$EXITFILE"';
    const [cmd, ...rest] = argv(o, this.out, free);
    this.child = spawn('/bin/sh', ['-c', script, 'sh', cmd, ...rest], {
      cwd: folder, env: { ...env, EXITFILE: this.exit, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', fd, fd], detached: true,
    });
    fs.closeSync(fd);
    this.child.unref();
  }

  // { state: 'running' | 'done' | 'failed', step, total, error }
  poll() {
    let text = '';
    try { text = fs.readFileSync(this.log, 'utf8'); } catch { /* not yet */ }
    const p = progress(text) || { step: 0, total: this.options.steps };
    if (!fs.existsSync(this.exit)) return { state: 'running', ...p };
    const code = Number(fs.readFileSync(this.exit, 'utf8').trim());
    if (code === 0 && fs.existsSync(this.out)) return { state: 'done', ...p };
    const lines = text.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !/\d+\/\d+ \[/.test(l));
    return { state: 'failed', ...p, error: lines.slice(-2).join(' ') || `exit ${code}` };
  }

  stop() {
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* gone */ }
  }

  cleanup() {
    try { fs.rmSync(this.tmp, { recursive: true, force: true }); } catch { /* fine */ }
  }
}

function setup(write, err) {
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
  if (!fs.existsSync(python())) { err('sage image: set Sage up first: sage --setup\n'); return 1; }
  // The build runs on mflux 0.21's qwen-2.1-edit pipeline.
  write(`Installing mflux ${MFLUX}…\n`);
  if (!run(python(), ['-m', 'pip', 'install', '-q', `mflux==${MFLUX}`])) { err('sage image: pip install failed\n'); return 1; }
  fs.mkdirSync(dir(), { recursive: true });
  write(`Downloading ${REPO} (${SIZE}) into ${dir()}…\n`);
  const snap = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(REPO)}, local_dir='.')\n`;
  if (!run(python(), ['-c', snap], { cwd: dir(), env: { ...process.env, HF_HUB_DISABLE_XET: '1' } })) { err('sage image: download failed\n'); return 1; }
  write('Sage can draw now — try: sage image "a lighthouse at dusk, oil painting"\n');
  return 0;
}

const HELP = `sage image — pictures from a prompt, made on your Mac
  sage image                     image chat: describe a picture, then say how to change it
  sage image <prompt>            a ${DEFAULTS.width}×${DEFAULTS.height} PNG here, opened in Preview
  sage image --size 1024x768 …   another size (256–2048, multiples of 32)
  sage image --steps 20 …        more steps: finer, slower (default ${DEFAULTS.steps})
  sage image --seed 7 …          the same seed and prompt make the same picture
  sage image -o name.png …       choose the file name (never over an existing file)
  sage image --no-open …         don't open it
  sage image --setup             install it (~${SIZE})
Qwen-Image 2.1 — Qwen Research License: research and evaluation, not commercial use.
`;

function runImage(args, io, shell) {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  if (args[0] === '--setup') return setup(write, err);
  if (args[0] === '--help' || args[0] === '-h') { write(HELP); return 0; }
  if (!args.length) {
    if (!(process.stdin.isTTY && process.stdout.isTTY && io.stdout.kind === 'term')) { write(HELP); return 1; }
    if (!ready()) { err('sage image: the image model isn’t set up — run: sage image --setup\n'); return 1; }
    const sage = require('./sage');
    const tui = require('./tui');
    const free = () => require('./gemma').freeMemory();
    const app = new sage.SageApp({
      mode: 'image', root: shell.cwd, model: 'image', models: [], start: () => sage.IDLE,
      startImage: (o) => new Job(o, shell.cwd, { env: shell.env, free: free() }),
    });
    return tui.fullscreen(() => sage.loop(app), { cursor: true, mouse: true });
  }
  const o = parseArgs(args);
  if (o.error) { err(`sage image: ${o.error}\n`); return 1; }
  if (!ready()) { err('sage image: the image model isn’t set up — run: sage image --setup\n'); return 1; }
  const out = o.output ? path.resolve(shell.cwd, o.output) : outputPath(o.prompt, shell.cwd);
  if (fs.existsSync(out)) { err(`sage image: ${o.output} is already there — pick another name\n`); return 1; }
  const muted = theme.style(theme.current().ui.muted);
  write(`${muted}✦ drawing ${o.width}×${o.height}, ${o.steps} steps — usually a few minutes${ansi.reset()}\n`);
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

module.exports = { runImage, Job, parseArgs, outputPath, argv, progress, ready, show, dir, DEFAULTS, REPO, HELP };
