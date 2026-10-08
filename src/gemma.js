'use strict';

// sage: Sage, maxshell's AI, on this Mac — Sage Pro and Sage Lite are Gemma 4
// E4B and E2B (Google's open models, run with transformers), Sage Ultra is
// Qwen2.5-Coder-7B (Alibaba's, run with MLX). The full-screen app is
// src/sage.js; the models run in src/sage.py under Sage's own Python
// (~/.maxshell/gemma/venv: the system PyTorch plus transformers, and mlx-lm
// for Ultra); `sage --setup` makes that Python and downloads the model into
// its folder. While mx training has the GPU, Gemma runs on the CPU, which is
// as fast then and doesn't slow the training.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The FP8 builds of Gemma 4 (instruction-tuned). E2B lives in the gemma
// folder itself; E4B, about twice the compute and memory, in gemma/e4b.
// Ultra, a 4-bit MLX build of Qwen2.5-Coder-7B-Instruct, in gemma/ultra.
const MODELS = {
  ultra: {
    name: 'ULTRA', label: 'Sage Ultra', flag: 'ultra', repo: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', sub: 'ultra',
    size: '4.3 GB', needFree: 30, mlx: true, files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors.index.json'],
  },
  e2b: { name: 'E2B', label: 'Sage Lite', flag: 'lite', repo: 'leon-se/gemma-4-E2B-it-FP8-Dynamic', sub: '', size: '9 GB', needFree: 25 },
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
const ready = (m = MODELS[DEFAULT]) => fs.existsSync(python()) && fs.existsSync(path.join(dir(m), 'model.safetensors'))
  && (m.files || FILES).every((f) => fs.existsSync(path.join(dir(m), f))) && (!m.mlx || !!process.env.MAXSHELL_GEMMA_PYTHON || hasMlx());

// --pro / --lite / --ultra (or --e4b / --e2b) at the front of the arguments,
// else $MAXSHELL_SAGE_MODEL, else Pro.
const ALIASES = { lite: 'e2b', pro: 'e4b' };
function pick(args) {
  const flag = /^--(e2b|e4b|lite|pro|ultra)$/i.exec(args[0] || '');
  if (flag) args = args.slice(1);
  let key = (flag ? flag[1] : process.env.MAXSHELL_SAGE_MODEL || DEFAULT).toLowerCase();
  key = ALIASES[key] || key;
  return { model: MODELS[key], key, args, chosen: !!(flag || process.env.MAXSHELL_SAGE_MODEL), flagged: !!flag };
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
  return { key: 'e2b', why: `Only ${free}% of memory is free and Sage Pro needs ${MODELS.e4b.needFree}%, so this is Sage Lite, the lighter model.` };
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
    if (!run(python(), ['-m', 'pip', 'install', '-q', 'mlx-lm'])) { err('sage: pip install failed\n'); return 1; }
    write(`Downloading ${m.repo} (${m.size}) into ${d}…\n`);
    const snap = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(m.repo)}, local_dir='.', allow_patterns=['*.json', '*.safetensors', '*.txt', '*.jinja'])\n`;
    if (spawnSync(python(), ['-c', snap], { cwd: d, stdio: 'inherit', env: { ...hubEnv(), HF_HUB_DISABLE_XET: '1' } }).status !== 0) { err('sage: download failed\n'); return 1; }
    write(`${m.label} is ready — try: sage --${m.flag}\n`);
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

// Where the engine runs and what it's told: the model folder, and the CPU
// while mx training has the GPU.
function engineEnv(m, shell) {
  const env = { ...shell.env, MAXSHELL_GEMMA: dir(m), MAXSHELL_SAGE_NAME: m.name, MAXSHELL_NODE: process.execPath };
  if (!env.MAXSHELL_SAGE_DEVICE && !m.mlx && training()) env.MAXSHELL_SAGE_DEVICE = 'cpu'; // MLX shares the GPU
  return env;
}

const HELP = `sage — an AI that runs entirely on your Mac
  sage                 chat, full screen (click the model to switch it)
  sage <question>      one answer, printed
  sage image <prompt>  a picture, made here (sage image --help)
  sage code [task]     Sage Code: a coding agent that reads, writes and edits
                       files and runs commands here — each one asked first
  sage code --ultra …  use Sage Ultra, the best at code (a 7B coding model; sage code only)
  sage --lite …        use Sage Lite, twice as fast (MAXSHELL_SAGE_MODEL=lite makes
                       it the default; Sage Pro is, unless memory is short)
  sage --setup         install what it needs (sage --ultra --setup for Sage Ultra,
                       sage --lite --setup for Sage Lite)
`;

function runSage(args, io, shell, name = 'sage') {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  let mode = 'chat';
  if (args[0] === 'image') return require('./sageimage').runImage(args.slice(1), io, shell);
  if (args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  let { model: m, key, args: rest, chosen, flagged } = pick(args);
  if (!m) { err(`${name}: no model ${key} — pro, ultra or lite\n`); return 1; }
  args = rest;
  if (mode === 'chat' && args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  const flag = m === MODELS[DEFAULT] ? '' : ` --${m.flag}`;
  if (args[0] === '--setup') return setup(m, write, err);
  if (args[0] === '--help' || args[0] === '-h') { write(HELP); return 0; }
  // Sage Ultra is a coding model, for sage code only: asked for by name in a
  // chat, say so; set as the default, chats use Sage Pro.
  if (mode === 'chat' && key === 'ultra') {
    if (flagged) { err(`${name}: Sage Ultra is for coding — use: sage code --ultra\n`); return 1; }
    key = DEFAULT;
    m = MODELS[key];
    chosen = false;
  }
  const auto = fallback(key, chosen);
  if (auto.key !== key) { key = auto.key; m = MODELS[key]; }
  if (!ready(m)) { err(`${name}: ${m.label} isn’t set up — run: sage${flag} --setup\n`); return 1; }
  const env = engineEnv(m, shell);
  const tty = process.stdin.isTTY && process.stdout.isTTY && io.stdout.kind === 'term' && io.stdin.kind !== 'string';

  if (tty && (mode === 'code' || !args.length)) {
    const sage = require('./sage');
    const tui = require('./tui');
    const keys = mode === 'code' ? ['ultra', 'e4b', 'e2b'] : ['e4b', 'e2b']; // the dropdown, best first; Ultra codes only
    const models = keys.map((k) => ({ key: k, ready: ready(MODELS[k]) }));
    const fake = process.env.MAXSHELL_SAGE_ENGINE; // tests: a stand-in for sage.py
    const start = (k, md) => new sage.Engine(
      fake ? [process.execPath, fake, '{commands}', md] : [python(), path.join(__dirname, 'sage.py'), '--serve', '{commands}', md],
      { cwd: shell.cwd, env: engineEnv(MODELS[k], shell) },
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

module.exports = { runSage, HELP, ready, pick, fallback, freeMemory, recent, MODELS, DEFAULT, REPO, FILES };
