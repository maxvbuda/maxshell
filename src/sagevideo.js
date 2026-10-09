'use strict';

// sage video: short clips from a prompt — or a picture brought to life —
// made on this Mac by Wan 2.2 TI2V-5B Turbo (Alibaba's open video model,
// Apache 2.0, distilled to 4 steps with no guidance — about a tenth of the
// base model's work — 4-bit, run with mlx-video on MLX; sagevideo.py builds
// it at setup and runs it with Sage's fixes). The model is in
// ~/.maxshell/gemma/video, with its own Python (mlx-video needs packages
// that would fight Sage's). A clip is saved as an MP4 in the current folder,
// named after the prompt — never over a file that's there — and opened.
//
// Then MMAudio (src/sageaudio.py, its own Python 3.12 in
// ~/.maxshell/gemma/audio; weights CC-BY-NC) watches the clip and adds the
// sound that goes with it. `sage video` with no prompt opens video chat in
// the Sage app: each message films a new version, "keep going" extends it.
//
// Like sage image, Sage Pro first turns the words into a detailed prompt —
// for a video, about what moves and what the camera does — then exits
// before the video model loads; --exact skips it. The background Job is
// sage image's, with this command line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const img = require('./sageimage');

const REPO = 'Kijai/WanVideo_comfy (Wan22-Turbo)';
const MLX_VIDEO = '87db56a51758fefb748a359b90a5283bb8ba4837'; // Blaizzy/mlx-video, pinned
const SIZE = '24 GB download, 17 GB kept';
const FPS = 24;
const DEFAULTS = { width: 1280, height: 704, seconds: 2, steps: 4 };
// Longer clips are made in segments of up to this long, each continuing from
// the last frame of the one before, so memory stays that of one segment and
// a clip can be any length — it just takes longer.
const SEGMENT = 2;
// Rough minutes per segment at the default size on an M3 (for the estimate).
const MINUTES_PER_SEGMENT = 18; // ~7 to make it, ~10 to decode it
const NEED_FREE = 45; // % of memory free: the text encoder alone is 11 GB

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = () => path.join(base(), 'video');
const modelDir = () => path.join(dir(), 'turbo');
const python = () => path.join(dir(), 'venv', 'bin', 'python');
const audioDir = () => path.join(base(), 'audio');
const audioPython = () => path.join(audioDir(), 'venv', 'bin', 'python');
// sageaudio.py --setup writes "ready" once every file is in (a half-done
// download has the right names already).
const soundReady = () => !!process.env.MAXSHELL_AUDIO_BIN || (fs.existsSync(audioPython()) && fs.existsSync(path.join(audioDir(), 'ready')));
const MMAUDIO = '974010a026c731054592d8f777218bd9d85a6c24'; // hkchengrex/MMAudio, pinned

// The command that gives a clip its sound (in place). The words, not Sage's
// long prompt, say what it should sound like.
function soundArgv(video, words) {
  const args = [video, video, '--prompt', words];
  if (process.env.MAXSHELL_AUDIO_BIN) return [process.env.MAXSHELL_AUDIO_BIN, ...args];
  return [audioPython(), path.join(__dirname, 'sageaudio.py'), '--dir', audioDir(), ...args];
}

const ready = () => !!process.env.MAXSHELL_VIDEO_BIN
  || (fs.existsSync(python()) && ['model.safetensors', 't5_encoder.safetensors', 'vae.safetensors'].every((f) => fs.existsSync(path.join(modelDir(), f))));

// Frames for a length: Wan makes 4n+1.
const frames = (seconds) => Math.max(1, Math.round((seconds * FPS) / 4)) * 4 + 1;

// How a clip is split: { segments, frames (each), seconds (in all) }.
function plan(seconds) {
  const segments = Math.max(1, Math.ceil(seconds / SEGMENT - 1e-9));
  const each = frames(seconds / segments);
  return { segments, frames: each, seconds: (segments * (each - 1) + 1) / FPS };
}

// sage video's options, or { error }.
function parseArgs(args) {
  const o = { ...DEFAULTS, seed: null, output: null, open: true, image: null, exact: false, sound: true };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '--size' || a === '-s') {
      const m = /^(\d+)x(\d+)$/.exec(next() || '');
      if (!m) return { error: 'size is WIDTHxHEIGHT, e.g. 832x480' };
      o.width = Number(m[1]);
      o.height = Number(m[2]);
    } else if (a === '--seconds' || a === '-t') o.seconds = Number(next());
    else if (a === '--steps') o.steps = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '-o' || a === '--output') o.output = next();
    else if (a === '--image' || a === '-i') o.image = next() || '';
    else if (a === '--no-open') o.open = false;
    else if (a === '--exact') o.exact = true;
    else if (a === '--no-sound') o.sound = false;
    else words.push(a);
  }
  o.prompt = words.join(' ').trim();
  if (!o.prompt) return { error: 'say what to film: sage video "a paper boat drifting down a rainy street"' };
  for (const k of ['width', 'height']) {
    if (!(o[k] >= 256 && o[k] <= 1280)) return { error: 'sizes go from 256 to 1280' };
    o[k] = Math.round(o[k] / 32) * 32;
  }
  if (!(o.seconds > 0 && Number.isFinite(o.seconds))) return { error: 'say how long in seconds, e.g. --seconds 10' };
  if (!(o.steps >= 1 && o.steps <= 60)) return { error: 'steps go from 1 to 60' };
  if (o.seed !== null && !Number.isInteger(o.seed)) return { error: 'the seed is a whole number' };
  return o;
}

// The command line for a clip. o.images (a prepared picture) starts it from that picture.
function argv(o, out) {
  const seed = o.seed ?? Math.floor(Math.random() * 1e9);
  const prompt = o.promptFile ? ['--prompt-file', o.promptFile] : ['--prompt', o.prompt];
  const p = plan(o.seconds);
  const flags = ['--model-dir', modelDir(), '--width', String(o.width), '--height', String(o.height),
    '--num-frames', String(p.frames), ...(p.segments > 1 ? ['--segments', String(p.segments)] : []), '--steps', String(o.steps), '--guide-scale', '1', // Turbo needs no guidance
    '--seed', String(seed), '--output-path', out];
  if (o.images && o.images.length) flags.push('--image', o.images[0]);
  if (o.previous) flags.push('--continue', o.previous); // carry on from this clip
  if (o.poster) flags.push('--poster', o.poster);
  if (process.env.MAXSHELL_VIDEO_BIN) return [process.env.MAXSHELL_VIDEO_BIN, ...prompt, ...flags];
  return [python(), path.join(__dirname, 'sagevideo.py'), ...prompt, ...flags]; // Wan, with Sage's fixes
}

// What Wan is doing, from its output: { stage, step, total, segment, segments }.
function progress(text) {
  const all = [...String(text).matchAll(/segment (\d+)\/(\d+)/g)];
  const seg = all.length ? { segment: Number(all[all.length - 1][1]), segments: Number(all[all.length - 1][2]) } : { segment: 1, segments: 1 };
  const t = all.length ? String(text).slice(all[all.length - 1].index) : String(text); // this segment's part
  const p = img.progress(t);
  const sound = [...String(text).matchAll(/sound (\d+)\/(\d+)/g)].pop();
  if (sound) return { stage: 'sound', ...(p || {}), ...seg, piece: Number(sound[1]), pieces: Number(sound[2]) };
  if (/Decoding with VAE/.test(t)) return { stage: 'decode', ...(p || {}), ...seg };
  if (p) return { stage: 'denoise', ...p, ...seg };
  if (/Encoding input image/.test(t)) return { stage: 'picture', ...seg };
  return { stage: 'prompt', ...seg };
}

// A clip in the background (for video chat), with its sound when o.sound
// and the sound model is set up. o.words: what to tell the sound model.
function job(o, folder, { env = process.env, free = 100, writer = null } = {}) {
  const out = o.output ? path.resolve(folder, o.output) : img.outputPath(o.prompt, folder, '.mp4');
  const then = o.sound && soundReady() ? [soundArgv(out, o.words || o.prompt)] : [];
  return new img.Job({ ...o, output: out }, folder, { env, free, writer, build: argv, ext: '.mp4', kind: 'video', parse: progress, then });
}

// Its own venv, Python 3.11+ (mlx-video needs it), then the 4-bit model.
function setup(write, err) {
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
  const recent = (py) => spawnSync(py, ['-c', 'import sys; sys.exit(sys.version_info < (3, 11))'], { stdio: 'ignore' }).status === 0;
  fs.mkdirSync(dir(), { recursive: true });
  if (!fs.existsSync(python()) || !recent(python())) {
    const py = ['python3.13', 'python3.12', 'python3.11', 'python3.14', 'python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(recent);
    if (!py) { err('sage video: needs Python 3.11 or newer — install it from python.org or with: brew install python\n'); return 1; }
    write(`Making a Python for Sage's video model (${py})…\n`);
    if (!run(py, ['-m', 'venv', '--clear', path.join(dir(), 'venv')])) { err('sage video: couldn’t make a venv\n'); return 1; }
  }
  write('Installing mlx-video…\n');
  if (!run(python(), ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'])
    || !run(python(), ['-m', 'pip', 'install', '-q', `git+https://github.com/Blaizzy/mlx-video.git@${MLX_VIDEO}`])) {
    err('sage video: pip install failed\n');
    return 1;
  }
  write(`Getting Wan 2.2 TI2V-5B Turbo (${SIZE}) into ${dir()}…\n`);
  // HF_HUB_VERBOSITY: no "set a HF_TOKEN" warning — public models need no account
  if (!run(python(), [path.join(__dirname, 'sagevideo.py'), '--setup', dir()], { cwd: dir(), env: { HF_HUB_VERBOSITY: 'error', ...process.env, HF_HUB_DISABLE_XET: '1' } })) {
    err('sage video: setup failed — run it again to pick up where it stopped\n');
    return 1;
  }
  if (setupSound(write, err) !== 0) write('(clips will be silent until that works: sage video --setup again)\n');
  write('Sage can film now — try: sage video "a paper boat drifting down a rainy street"\n');
  return 0;
}

// MMAudio in its own Python 3.12 (it needs numpy < 2.1, which has no build
// for 3.13): made with uv when it's there, else a python3.12 / 3.11.
function setupSound(write, err) {
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
  const has = (cmd) => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  fs.mkdirSync(audioDir(), { recursive: true });
  const venv = path.join(audioDir(), 'venv');
  const pkgs = ['torch', 'torchvision', 'torchaudio', 'imageio-ffmpeg', 'soundfile', `git+https://github.com/hkchengrex/MMAudio.git@${MMAUDIO}`];
  write('Installing MMAudio, for sound…\n');
  if (has('uv')) {
    if (!fs.existsSync(audioPython()) && !run('uv', ['venv', '--python', '3.12', venv])) { err('sage video: couldn’t make a Python for sound\n'); return 1; }
    if (!run('uv', ['pip', 'install', '-q', ...pkgs], { env: { ...process.env, VIRTUAL_ENV: venv } })) { err('sage video: installing MMAudio failed\n'); return 1; }
  } else {
    const py = ['python3.12', 'python3.11'].find(has);
    if (!py) { err('sage video: sound needs Python 3.12 or 3.11, or uv (brew install uv)\n'); return 1; }
    if (!fs.existsSync(audioPython()) && !run(py, ['-m', 'venv', venv])) { err('sage video: couldn’t make a Python for sound\n'); return 1; }
    if (!run(audioPython(), ['-m', 'pip', 'install', '-q', ...pkgs])) { err('sage video: installing MMAudio failed\n'); return 1; }
  }
  write('Downloading MMAudio (5 GB)…\n');
  if (!run(audioPython(), [path.join(__dirname, 'sageaudio.py'), '--setup'], { cwd: audioDir(), env: { HF_HUB_VERBOSITY: 'error', ...process.env } })) { err('sage video: downloading MMAudio failed\n'); return 1; }
  return 0;
}

const HELP = `sage video — short clips made on your Mac
  sage video <prompt>              a ${DEFAULTS.seconds}-second ${DEFAULTS.width}×${DEFAULTS.height} MP4 here, opened when done
  sage video --image pic.jpg …     bring a picture to life: say what moves
  sage video --seconds 30 …        any length: made ${SEGMENT} s at a time, each part carrying on
                                   from the last — it just takes longer
  sage video --size 832x480 …      another size (up to 1280; it's made for 1280×704)
  sage video --steps 6 …           more steps: finer, slower (default ${DEFAULTS.steps})
  sage video --seed 7 …            the same seed and prompt make the same clip
  sage video -o name.mp4 …         choose the file name (never over an existing file)
  sage video --exact …             film your words as they are (Sage Pro writes a detailed
                                   prompt from them first, by default)
  sage video --no-sound …          no soundtrack (MMAudio adds one by default, if set up)
  sage video                       video chat: describe a clip, then change it or say "keep going"
  sage video --no-open …           don't open it
  sage video --setup               install it (~${SIZE}, and MMAudio for sound, 5 GB)
Wan 2.2 TI2V-5B Turbo (Alibaba's Wan, distilled by quanhaol) — Apache 2.0.
Sound: MMAudio — weights CC-BY-NC 4.0, non-commercial use only.
`;

function runVideo(args, io, shell) {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  if (args[0] === '--setup') return setup(write, err);
  if (args[0] === '--help' || args[0] === '-h') { write(HELP); return 0; }
  if (!args.length) { // video chat
    if (!(process.stdin.isTTY && process.stdout.isTTY && io.stdout.kind === 'term')) { write(HELP); return 1; }
    if (!ready()) { err('sage video: the video model isn’t set up — run: sage video --setup\n'); return 1; }
    const sage = require('./sage');
    const tui = require('./tui');
    const gemma = require('./gemma');
    const app = new sage.SageApp({
      mode: 'video', root: shell.cwd, model: 'video', models: [], start: () => sage.IDLE,
      startVideo: (o) => job(o, shell.cwd, { env: shell.env, free: gemma.freeMemory(), writer: o.exact ? null : gemma.promptWriter(shell) }),
    });
    if (!soundReady()) app.clipOpts.sound = false;
    return tui.fullscreen(() => sage.loop(app), { cursor: true, mouse: true });
  }
  const o = parseArgs(args);
  if (o.error) { err(`sage video: ${o.error}\n`); return 1; }
  if (!ready()) { err('sage video: the video model isn’t set up — run: sage video --setup\n'); return 1; }
  if (o.image) {
    const mine = img.prepare(o.image, shell.cwd);
    if (mine.error) { err(`sage video: ${mine.error}\n`); return 1; }
    o.images = [mine.file];
  }
  const out = o.output ? path.resolve(shell.cwd, o.output) : img.outputPath(o.prompt, shell.cwd, '.mp4');
  if (fs.existsSync(out)) { err(`sage video: ${o.output} is already there — pick another name\n`); return 1; }
  const muted = theme.style(theme.current().ui.muted);
  const writer = o.exact ? null : require('./gemma').promptWriter(shell);
  if (writer) { // Sage turns the words into a detailed prompt first
    write(`${muted}✦ ${writer.label} is writing a detailed prompt…${ansi.reset()}\n`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-prompt-'));
    fs.writeFileSync(path.join(tmp, 'request.json'), img.request(o, 'video'));
    const [cmd, ...rest] = writer.cmd;
    const r = spawnSync(cmd, [...rest, '--image-prompt', path.join(tmp, 'request.json'), path.join(tmp, 'detailed.txt')], { env: { ...shell.env, ...writer.env }, encoding: 'utf8' });
    let detailed = null;
    try { detailed = fs.readFileSync(path.join(tmp, 'detailed.txt'), 'utf8').trim(); } catch { /* it couldn't */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (detailed) {
      o.prompt = detailed;
      for (const l of img.wrapText(detailed, Math.max(20, (process.stdout.columns || 80) - 4))) write(`${muted}  ${l}${ansi.reset()}\n`);
    } else write(`${muted}  (${img.lastLine(r.stderr) || 'Sage didn’t answer'} — filming your words)${ansi.reset()}\n`);
  }
  const free = require('./gemma').freeMemory();
  if (free < NEED_FREE) write(`${theme.style(theme.current().ui.warn)}! only ${free}% of memory is free — the video model needs about 12 GB; close what you can${ansi.reset()}\n`);
  const p = plan(o.seconds);
  const mins = p.segments * MINUTES_PER_SEGMENT * ((o.width * o.height) / (DEFAULTS.width * DEFAULTS.height)) * (o.steps / DEFAULTS.steps + 1) / 2;
  const about = mins >= 90 ? `about ${Math.round(mins / 60)} hours` : `about ${Math.max(1, Math.round(mins))} minutes`;
  const parts = p.segments > 1 ? ` in ${p.segments} parts of ${SEGMENT} s` : '';
  write(`${muted}✦ filming ${o.width}×${o.height}, ${+p.seconds.toFixed(1)} s${parts}, ${o.steps} step${o.steps === 1 ? '' : 's'} — ${about} on an M3${ansi.reset()}\n`);
  const began = Date.now();
  const status = shell.runExternal(argv(o, out), io, { ...shell.env, PYTHONUNBUFFERED: '1', HF_HUB_VERBOSITY: 'error' });
  if (status !== 0 || !fs.existsSync(out)) { err('sage video: the clip wasn’t made\n'); return status || 1; }
  if (o.sound && soundReady()) { // MMAudio watches it and adds the sound
    write(`${muted}✦ adding sound…${ansi.reset()}\n`);
    const words = args.filter((a, i) => !a.startsWith('-') && !(i && /^--?(size|s|seconds|t|steps|seed|o|output|image|i)$/.test(args[i - 1]))).join(' ');
    if (shell.runExternal(soundArgv(out, words), io, { ...shell.env, PYTHONUNBUFFERED: '1' }) !== 0) write(`${muted}  (the sound didn’t work — the clip is silent)${ansi.reset()}\n`);
  } else if (o.sound) write(`${muted}  (silent: set up sound with sage video --setup)${ansi.reset()}\n`);
  const secs = Math.round((Date.now() - began) / 1000);
  const where = path.relative(shell.cwd, out) || out;
  write(`${theme.style(theme.current().ui.ok)}✓${ansi.reset()} saved ${where} ${muted}(${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`})${ansi.reset()}\n`);
  if (o.open && io.stdout.kind === 'term') img.openFile(out);
  return 0;
}

module.exports = { runVideo, job, parseArgs, argv, progress, frames, plan, ready, soundReady, soundArgv, dir, DEFAULTS, SEGMENT, REPO, HELP };
