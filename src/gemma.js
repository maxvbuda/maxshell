'use strict';

// sage: Sage, maxshell's AI, on this Mac — Sage Pro and Sage Flash are Gemma
// 4 E4B and E2B (Google's open models, run with transformers), Sage Lite is
// SmolLM2-1.7B (Hugging Face's, run with MLX: tiny and very fast), Sage Ultra is
// Gemma 4 26B-A4B in a chat and Qwen2.5-Coder-7B (Alibaba's) in sage code,
// both run with MLX. The full-screen app is src/sage.js; the models run in
// src/sage.py under Sage's own Python (~/.maxshell/gemma/venv: the system
// PyTorch plus transformers, and mlx-lm for Ultra); `sage --setup` makes that
// Python and downloads the model into its folder. While mx training has the
// GPU, Gemma runs on the CPU, which is as fast then and doesn't slow the
// training.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The FP8 builds of Gemma 4 (instruction-tuned). E2B lives in the gemma
// folder itself; E4B, about twice the compute and memory, in gemma/e4b.
// Ultra, a 4-bit MLX build of Qwen2.5-Coder-7B-Instruct, in gemma/ultra;
// in a chat, Ultra is a 4-bit MLX build of Gemma 4 26B-A4B (a mixture of
// experts: 26B parameters, about 4B used for each token, so it's quick), in
// gemma/ultra-chat.
const MODELS = {
  ultra: {
    name: 'ULTRA', label: 'Sage Ultra', flag: 'ultra', repo: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', sub: 'ultra',
    size: '4.3 GB', needFree: 30, mlx: true, files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors.index.json'],
    try: 'sage code --ultra',
  },
  ultrachat: {
    name: 'ULTRA-CHAT', label: 'Sage Ultra', flag: 'ultra', repo: 'mlx-community/gemma-4-26b-a4b-it-4bit', sub: 'ultra-chat',
    size: '15 GB', needFree: 60, mlx: true, sharded: true, try: 'sage --ultra',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'model.safetensors.index.json'],
  },
  e2b: { name: 'E2B', label: 'Sage Flash', flag: 'flash', repo: 'leon-se/gemma-4-E2B-it-FP8-Dynamic', sub: '', size: '9 GB', needFree: 25 },
  // Lite: SmolLM2-1.7B-Instruct, made 4-bit for MLX here (in gemma/lite):
  // about 70 tokens a second, nearly three times its 8-bit build.
  lite: {
    name: 'LITE', label: 'Sage Lite', flag: 'lite', repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', sub: 'lite',
    size: '3.4 GB', needFree: 15, mlx: true, quantize: true, try: 'sage --lite',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors.index.json'],
  },
  // Lite in sage code: Qwen2.5-Coder-3B-Instruct, 4-bit MLX, in gemma/lite-code.
  litecode: {
    name: 'LITE-CODE', label: 'Sage Lite', flag: 'lite', repo: 'mlx-community/Qwen2.5-Coder-3B-Instruct-4bit', sub: 'lite-code',
    size: '1.8 GB', needFree: 15, mlx: true, try: 'sage code --lite',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors.index.json'],
  },
  e4b: { name: 'E4B', label: 'Sage Pro', flag: 'pro', repo: 'leon-se/gemma-4-E4B-it-FP8-Dynamic', sub: 'e4b', size: '13 GB', needFree: 40 },
};
const DEFAULT = 'e4b';
const REPO = MODELS[DEFAULT].repo;
const FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'];

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = (m = MODELS[DEFAULT]) => path.join(base(), m.sub);
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(base(), 'venv', 'bin', 'python');
// mlx-lm, which Ultra needs, in Sage's Python.
function hasMlx() {
  const lib = path.join(path.dirname(path.dirname(python())), 'lib');
  try { return fs.readdirSync(lib).some((v) => fs.existsSync(path.join(lib, v, 'site-packages', 'mlx_lm'))); } catch { return false; }
}
// The weights: one file, or the shards the index lists.
function weights(m) {
  if (!m.sharded) return ['model.safetensors'];
  try {
    return [...new Set(Object.values(JSON.parse(fs.readFileSync(path.join(dir(m), 'model.safetensors.index.json'), 'utf8')).weight_map))];
  } catch { return ['model.safetensors.index.json']; }
}
const ready = (m = MODELS[DEFAULT]) => fs.existsSync(python()) && weights(m).every((f) => fs.existsSync(path.join(dir(m), f)))
  && (m.files || FILES).every((f) => fs.existsSync(path.join(dir(m), f))) && (!m.mlx || !!process.env.MAXSHELL_GEMMA_PYTHON || hasMlx());

// --pro / --flash / --lite / --ultra (or --e4b / --e2b) at the front of the arguments,
// else $MAXSHELL_SAGE_MODEL, else Pro.
const ALIASES = { flash: 'e2b', pro: 'e4b' };
function pick(args) {
  const flag = /^--(e2b|e4b|flash|lite|pro|ultra)$/i.exec(args[0] || '');
  if (flag) args = args.slice(1);
  let key = (flag ? flag[1] : process.env.MAXSHELL_SAGE_MODEL || DEFAULT).toLowerCase();
  key = ALIASES[key] || key;
  return { model: MODELS[key], key, args, chosen: !!(flag || process.env.MAXSHELL_SAGE_MODEL), flagged: !!flag };
}
// Sage Ultra and Sage Lite are chat models in a chat and coding models in
// sage code.
function modelFor(key, mode) {
  if (key === 'ultra') return mode === 'code' ? MODELS.ultra : MODELS.ultrachat;
  if (key === 'lite') return mode === 'code' ? MODELS.litecode : MODELS.lite;
  return MODELS[key];
}

// % of memory free — on a Mac the GPU's memory is the same memory.
// MAXSHELL_SAGE_FREE stands in for it in tests.
function freeMemory() {
  if (process.env.MAXSHELL_SAGE_FREE) return Number(process.env.MAXSHELL_SAGE_FREE);
  const n = parseInt(spawnSync('sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' }).stdout, 10);
  return Number.isFinite(n) ? n : 100;
}

// When no model was asked for and there isn't room for E4B, E2B (if it's set
// up) instead: { key, why }.
function fallback(key, chosen) {
  if (chosen || key !== 'e4b' || !ready(MODELS.e2b)) return { key };
  const free = freeMemory();
  if (free >= MODELS.e4b.needFree) return { key };
  return { key: 'e2b', why: `Only ${free}% of memory is free and Sage Pro needs ${MODELS.e4b.needFree}%, so this is Sage Flash, the lighter model.` };
}
const training = () => spawnSync('pgrep', ['-f', 'ai/mx2/train.py']).status === 0;

// transformers 5 needs Python 3.10+; macOS's /usr/bin/python3 is 3.9.
const recent = (py) => spawnSync(py, ['-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], { stdio: 'ignore' }).status === 0;
const PYTHONS = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.14', 'python3',
  '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/Library/Frameworks/Python.framework/Versions/Current/bin/python3'];
const findPython = () => PYTHONS.find(recent);

// Downloads without Hugging Face's "set a HF_TOKEN for higher rate limits"
// warning: public models need no account.
const hubEnv = () => ({ HF_HUB_VERBOSITY: 'error', ...process.env });

function setup(m, write, err) {
  const d = dir(m);
  fs.mkdirSync(d, { recursive: true });
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
  const venv = path.join(base(), 'venv');
  // A venv made from a Python older than 3.10 (macOS's own is 3.9) can't have
  // transformers 5; it's ours, so make it again.
  if (fs.existsSync(python()) && !recent(python()) && !process.env.MAXSHELL_GEMMA_PYTHON) {
    write('Sage’s Python is too old for transformers 5 — making it again…\n');
    fs.rmSync(venv, { recursive: true, force: true });
  }
  if (!fs.existsSync(python())) {
    const py = findPython();
    if (!py) { err('sage: Sage needs Python 3.10 or newer — install it (brew install python, or python.org) and run sage --setup again\n'); return 1; }
    write(`Making a Python for Sage from ${py}…\n`);
    if (!run(py, ['-m', 'venv', '--system-site-packages', venv])) { err('sage: couldn’t make the venv\n'); return 1; }
  }
  const hasTorch = spawnSync(python(), ['-c', 'import torch'], { stdio: 'ignore' }).status === 0;
  write(hasTorch ? 'Installing transformers…\n' : 'Installing PyTorch and transformers…\n');
  if (!run(python(), ['-m', 'pip', 'install', '-q', 'transformers>=5.5', ...(hasTorch ? [] : ['torch'])])) { err('sage: pip install failed\n'); return 1; }
  if (m.mlx) {
    write('Installing mlx-lm…\n');
    if (!run(python(), ['-m', 'pip', 'install', '-q', 'mlx-lm>=0.32'])) { err('sage: pip install failed\n'); return 1; }
    if (m.quantize) return quantize(m, d, write, err);
    write(`Downloading ${m.repo} (${m.size}) into ${d}…\n`);
    const snap = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(m.repo)}, local_dir='.', allow_patterns=['*.json', '*.safetensors', '*.txt', '*.jinja'])\n`;
    if (spawnSync(python(), ['-c', snap], { cwd: d, stdio: 'inherit', env: { ...hubEnv(), HF_HUB_DISABLE_XET: '1' } }).status !== 0) { err('sage: download failed\n'); return 1; }
    write(`${m.label} is ready — try: ${m.try}\n`);
    return 0;
  }
  write(`Fetching the config and tokenizer from ${m.repo}…\n`);
  const fetch = (files) => `from huggingface_hub import hf_hub_download\nfor f in ${JSON.stringify(files)}:\n    hf_hub_download(${JSON.stringify(m.repo)}, f, local_dir='.')\n`;
  if (spawnSync(python(), ['-c', fetch(FILES)], { cwd: d, stdio: 'inherit', env: hubEnv() }).status !== 0) { err('sage: download failed\n'); return 1; }
  const model = path.join(d, 'model.safetensors');
  if (!fs.existsSync(model)) {
    write(`Downloading ${m.repo}'s model.safetensors (${m.size}) into ${d}…\n`);
    if (spawnSync(python(), ['-c', fetch(['model.safetensors'])], { cwd: d, stdio: 'inherit', env: hubEnv() }).status !== 0) { err('sage: download failed\n'); return 1; }
  }
  write(`${m.label} is ready — try: sage${m === MODELS[DEFAULT] ? '' : ` --${m.flag}`}\n`);
  return 0;
}

// Downloads the full model into a folder of its own, makes the 4-bit MLX
// build from it into the model's folder, and removes the download.
function quantize(m, d, write, err) {
  if (ready(m)) { write(`${m.label} is ready — try: ${m.try}\n`); return 0; }
  const src = `${d}.download`;
  const out = `${d}.part`;
  for (const p of [src, out]) fs.rmSync(p, { recursive: true, force: true }); // ours, from a setup cut short
  write(`Downloading ${m.repo} (${m.size})…\n`);
  const snap = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(m.repo)}, local_dir=${JSON.stringify(src)}, allow_patterns=['*.json', '*.safetensors', '*.txt', '*.jinja'])\n`;
  if (spawnSync(python(), ['-c', snap], { stdio: 'inherit', env: { ...hubEnv(), HF_HUB_DISABLE_XET: '1' } }).status !== 0) { err('sage: download failed\n'); return 1; }
  write(`Making it 4-bit, into ${d}…\n`);
  const ok = spawnSync(python(), ['-m', 'mlx_lm', 'convert', '--hf-path', src, '-q', '--q-bits', '4', '--q-group-size', '64', '--mlx-path', out], { stdio: 'inherit', env: hubEnv() }).status === 0;
  fs.rmSync(src, { recursive: true, force: true });
  if (!ok) { fs.rmSync(out, { recursive: true, force: true }); err('sage: converting the model failed\n'); return 1; }
  fs.rmSync(d, { recursive: true, force: true }); // the empty folder setup made
  fs.renameSync(out, d);
  write(`${m.label} is ready — try: ${m.try}\n`);
  return 0;
}

// Where the engine runs and what it's told: the model folder, and the CPU
// while mx training has the GPU.
function engineEnv(m, shell) {
  const env = { ...shell.env, MAXSHELL_GEMMA: dir(m), MAXSHELL_SAGE_NAME: m.name, MAXSHELL_NODE: process.execPath };
  if (!env.MAXSHELL_SAGE_DEVICE && !m.mlx && training()) env.MAXSHELL_SAGE_DEVICE = 'cpu'; // MLX shares the GPU
  return env;
}

// sage image's prompt writer: Sage Pro (Sage Flash when memory is short or
// Pro isn't set up) as a command that turns a request into a detailed
// prompt — { label, cmd, env } — or null when neither is set up.
function promptWriter(shell) {
  const fake = process.env.MAXSHELL_SAGE_WRITER; // tests: a stand-in for sage.py
  if (fake) return { label: 'Sage Pro', cmd: [process.execPath, fake], env: {} };
  let key = fallback(DEFAULT, false).key;
  if (!ready(MODELS[key])) key = ['e4b', 'e2b'].find((k) => ready(MODELS[k]));
  if (!key) return null;
  return { label: MODELS[key].label, cmd: [python(), path.join(__dirname, 'sage.py')], env: engineEnv(MODELS[key], shell) };
}

const HELP = `sage — an AI that runs entirely on your Mac
  sage                 chat, full screen (click the model to switch it)
  sage <question>      one answer, printed
  sage image <prompt>  a picture, made here (sage image --help)
  sage video <prompt>  a short clip, made here (sage video --help)
  sage code [task]     Sage Code: a coding agent that reads, writes and edits
                       files and runs commands here — each one asked first
  sage --ultra …       use Sage Ultra, the smartest (needs ~15 GB of memory) —
                       in sage code, a coding model, the best at code
  sage --flash …       use Sage Flash, twice as fast as Pro (MAXSHELL_SAGE_MODEL=flash
                       makes it the default; Sage Pro is, unless memory is short)
  sage --lite …        use Sage Lite, tiny and the fastest of all — in sage code,
                       a small coding model
  sage --setup         install what it needs (sage --ultra --setup for Sage Ultra,
                       sage code --ultra --setup for the coding one,
                       sage --flash --setup, sage --lite --setup,
                       sage code --lite --setup)
`;

function runSage(args, io, shell, name = 'sage') {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  let mode = 'chat';
  if (args[0] === 'image') return require('./sageimage').runImage(args.slice(1), io, shell);
  if (args[0] === 'video') return require('./sagevideo').runVideo(args.slice(1), io, shell);
  if (args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  let { model: m, key, args: rest, chosen } = pick(args);
  if (!m) { err(`${name}: no model ${key} — ultra, pro, flash or lite\n`); return 1; }
  args = rest;
  if (mode === 'chat' && args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  m = modelFor(key, mode);
  const flag = m === MODELS[DEFAULT] ? '' : ` --${m.flag}`;
  if (args[0] === '--setup') return setup(m, write, err);
  if (args[0] === '--help' || args[0] === '-h') { write(HELP); return 0; }
  const auto = fallback(key, chosen);
  if (auto.key !== key) { key = auto.key; m = MODELS[key]; }
  if (!ready(m)) { err(`${name}: ${m.label} isn’t set up — run: sage${mode === 'code' ? ' code' : ''}${flag} --setup\n`); return 1; }
  const env = engineEnv(m, shell);
  const tty = process.stdin.isTTY && process.stdout.isTTY && io.stdout.kind === 'term' && io.stdin.kind !== 'string';

  if (tty && (mode === 'code' || !args.length)) {
    const sage = require('./sage');
    const tui = require('./tui');
    const keys = ['ultra', 'e4b', 'e2b', 'lite']; // the dropdown, best first
    const models = keys.map((k) => ({ key: k, ready: ready(modelFor(k, mode)) }));
    const fake = process.env.MAXSHELL_SAGE_ENGINE; // tests: a stand-in for sage.py
    const start = (k, md) => new sage.Engine(
      fake ? [process.execPath, fake, '{commands}', md] : [python(), path.join(__dirname, 'sage.py'), '--serve', '{commands}', md],
      { cwd: shell.cwd, env: engineEnv(modelFor(k, mode), shell) },
    );
    const img = require('./sageimage');
    const startImage = img.ready() ? (o) => new img.Job(o, shell.cwd, { env: shell.env, free: freeMemory() }) : null;
    const app = new sage.SageApp({ mode, root: shell.cwd, model: key, models, start, ask: args.length ? args.join(' ') : null, notice: auto.why, startImage });
    return tui.fullscreen(() => sage.loop(app), { cursor: true, mouse: true });
  }
  if (mode === 'code') { err(`${name}: sage code needs a terminal\n`); return 1; }
  if (auto.why) err(`${theme.style(theme.current().ui.muted)}${auto.why}${ansi.reset()}\n`);

  // One answer, or a plain chat when this isn't a terminal: sage.py prints
  // it, with replies rendered by src/markdown.js in this theme.
  const t = theme.current();
  const colors = {
    accent: ansi.fg(t.ui.accent), accent2: ansi.fg(t.ui.accent2), muted: ansi.fg(t.ui.muted),
    bold: ansi.bold(), reset: ansi.reset(),
  };
  Object.assign(env, { MAXSHELL_SAGE_COLORS: JSON.stringify(colors), MAXSHELL_THEME: theme.currentThemeName() });
  return shell.runExternal([python(), path.join(__dirname, 'sage.py'), ...args], io, env);
}

module.exports = { promptWriter, runSage, HELP, ready, pick, modelFor, fallback, freeMemory, recent, MODELS, DEFAULT, REPO, FILES };
