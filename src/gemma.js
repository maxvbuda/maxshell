'use strict';

// sage: Sage, maxshell's AI — Gemma 4 (E4B, or E2B
// with --e2b), Google's open model, on this Mac. The full-screen app is
// src/sage.js. The model runs in src/gemma.py under its own Python
// (~/.maxshell/gemma/venv: the system PyTorch plus transformers); `sage
// --setup` makes that Python and downloads the model into its folder. While
// mx training has the GPU, Gemma runs on the CPU, which is as fast then and
// doesn't slow the training.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The FP8 builds of Gemma 4 (instruction-tuned). E2B lives in the gemma
// folder itself; E4B, about twice the compute and memory, in gemma/e4b.
const MODELS = {
  e2b: { name: 'E2B', repo: 'leon-se/gemma-4-E2B-it-FP8-Dynamic', sub: '', size: '9 GB', needFree: 25 },
  e4b: { name: 'E4B', repo: 'leon-se/gemma-4-E4B-it-FP8-Dynamic', sub: 'e4b', size: '13 GB', needFree: 40 },
};
const DEFAULT = 'e4b';
const REPO = MODELS[DEFAULT].repo;
const FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'];

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = (m = MODELS[DEFAULT]) => path.join(base(), m.sub);
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(base(), 'venv', 'bin', 'python');
const ready = (m = MODELS[DEFAULT]) => fs.existsSync(python()) && fs.existsSync(path.join(dir(m), 'model.safetensors')) && FILES.every((f) => fs.existsSync(path.join(dir(m), f)));

// --e2b / --e4b at the front of the arguments, else $MAXSHELL_SAGE_MODEL, else E4B.
function pick(args) {
  const flag = /^--(e2b|e4b)$/i.exec(args[0] || '');
  if (flag) args = args.slice(1);
  const key = (flag ? flag[1] : process.env.MAXSHELL_SAGE_MODEL || DEFAULT).toLowerCase();
  return { model: MODELS[key], key, args, chosen: !!(flag || process.env.MAXSHELL_SAGE_MODEL) };
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
  return { key: 'e2b', why: `Only ${free}% of memory is free and E4B needs ${MODELS.e4b.needFree}%, so Sage is using E2B, the lighter model.` };
}
const training = () => spawnSync('pgrep', ['-f', 'ai/mx2/train.py']).status === 0;

// transformers 5 needs Python 3.10+; macOS's /usr/bin/python3 is 3.9.
const recent = (py) => spawnSync(py, ['-c', 'import sys; sys.exit(sys.version_info < (3, 10))'], { stdio: 'ignore' }).status === 0;
const PYTHONS = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.14', 'python3',
  '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/Library/Frameworks/Python.framework/Versions/Current/bin/python3'];
const findPython = () => PYTHONS.find(recent);

function setup(m, write, err) {
  const d = dir(m);
  fs.mkdirSync(d, { recursive: true });
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
  const venv = path.join(base(), 'venv');
  // A venv made from a Python older than 3.10 (macOS's own is 3.9) can't have
  // transformers 5; it's ours, so make it again.
  if (fs.existsSync(python()) && !recent(python()) && !process.env.MAXSHELL_GEMMA_PYTHON) {
    write('Gemma’s Python is too old for transformers 5 — making it again…\n');
    fs.rmSync(venv, { recursive: true, force: true });
  }
  if (!fs.existsSync(python())) {
    const py = findPython();
    if (!py) { err('sage: Gemma needs Python 3.10 or newer — install it (brew install python, or python.org) and run sage --setup again\n'); return 1; }
    write(`Making a Python for Gemma from ${py}…\n`);
    if (!run(py, ['-m', 'venv', '--system-site-packages', venv])) { err('sage: couldn’t make the venv\n'); return 1; }
  }
  const hasTorch = spawnSync(python(), ['-c', 'import torch'], { stdio: 'ignore' }).status === 0;
  write(hasTorch ? 'Installing transformers…\n' : 'Installing PyTorch and transformers…\n');
  if (!run(python(), ['-m', 'pip', 'install', '-q', 'transformers>=5.5', ...(hasTorch ? [] : ['torch'])])) { err('sage: pip install failed\n'); return 1; }
  write(`Fetching the config and tokenizer from ${m.repo}…\n`);
  const fetch = (files) => `from huggingface_hub import hf_hub_download\nfor f in ${JSON.stringify(files)}:\n    hf_hub_download(${JSON.stringify(m.repo)}, f, local_dir='.')\n`;
  if (spawnSync(python(), ['-c', fetch(FILES)], { cwd: d, stdio: 'inherit' }).status !== 0) { err('sage: download failed\n'); return 1; }
  const model = path.join(d, 'model.safetensors');
  if (!fs.existsSync(model)) {
    write(`Downloading ${m.repo}'s model.safetensors (${m.size}) into ${d}…\n`);
    if (spawnSync(python(), ['-c', fetch(['model.safetensors'])], { cwd: d, stdio: 'inherit' }).status !== 0) { err('sage: download failed\n'); return 1; }
  }
  write(`Sage (Gemma 4 ${m.name}) is ready — try: sage${m === MODELS[DEFAULT] ? '' : ' --' + m.name.toLowerCase()}\n`);
  return 0;
}

// Where the engine runs and what it's told: the model folder, and the CPU
// while mx training has the GPU.
function engineEnv(m, shell) {
  const env = { ...shell.env, MAXSHELL_GEMMA: dir(m), MAXSHELL_SAGE_NAME: m.name, MAXSHELL_NODE: process.execPath };
  if (!env.MAXSHELL_SAGE_DEVICE && training()) env.MAXSHELL_SAGE_DEVICE = 'cpu';
  return env;
}

const HELP = `sage — Google's Gemma 4, running entirely on your Mac
  sage                 chat, full screen (click the model to switch it)
  sage <question>      one answer, printed
  sage code [task]     Sage Code: a coding agent that reads, writes and edits
                       files here — every change shown as a diff and asked first
  sage --e2b …         use E2B, the smaller, faster model (MAXSHELL_SAGE_MODEL=e2b
                       makes it the default; E4B is, unless memory is short)
  sage --setup         install what it needs (sage --e2b --setup for E2B)
`;

function runSage(args, io, shell, name = 'sage') {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  let mode = 'chat';
  if (args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  let { model: m, key, args: rest, chosen } = pick(args);
  if (!m) { err(`${name}: no Gemma model ${key} — e2b or e4b\n`); return 1; }
  args = rest;
  if (mode === 'chat' && args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  const flag = m === MODELS[DEFAULT] ? '' : ` --${key}`;
  if (args[0] === '--setup') return setup(m, write, err);
  if (args[0] === '--help' || args[0] === '-h') { write(HELP); return 0; }
  const auto = fallback(key, chosen);
  if (auto.key !== key) { key = auto.key; m = MODELS[key]; }
  if (!ready(m)) { err(`${name}: Sage’s model (Gemma 4 ${m.name}) isn’t set up — run: sage${flag} --setup\n`); return 1; }
  const env = engineEnv(m, shell);
  const tty = process.stdin.isTTY && process.stdout.isTTY && io.stdout.kind === 'term' && io.stdin.kind !== 'string';

  if (tty && (mode === 'code' || !args.length)) {
    const sage = require('./sage');
    const tui = require('./tui');
    const keys = [DEFAULT, ...Object.keys(MODELS).filter((k) => k !== DEFAULT)];
    const models = keys.map((k) => ({ key: k, ready: ready(MODELS[k]) }));
    const fake = process.env.MAXSHELL_SAGE_ENGINE; // tests: a stand-in for gemma.py
    const start = (k, md) => new sage.Engine(
      fake ? [process.execPath, fake, '{commands}', md] : [python(), path.join(__dirname, 'gemma.py'), '--serve', '{commands}', md],
      { cwd: shell.cwd, env: engineEnv(MODELS[k], shell) },
    );
    const app = new sage.SageApp({ mode, root: shell.cwd, model: key, models, start, ask: args.length ? args.join(' ') : null, notice: auto.why });
    return tui.fullscreen(() => sage.loop(app), { cursor: true, mouse: true });
  }
  if (mode === 'code') { err(`${name}: sage code needs a terminal\n`); return 1; }
  if (auto.why) err(`${theme.style(theme.current().ui.muted)}${auto.why}${ansi.reset()}\n`);

  // One answer, or a plain chat when this isn't a terminal: gemma.py prints
  // it, with replies rendered by src/markdown.js in this theme.
  const t = theme.current();
  const colors = {
    accent: ansi.fg(t.ui.accent), accent2: ansi.fg(t.ui.accent2), muted: ansi.fg(t.ui.muted),
    bold: ansi.bold(), reset: ansi.reset(),
  };
  Object.assign(env, { MAXSHELL_SAGE_COLORS: JSON.stringify(colors), MAXSHELL_THEME: theme.currentThemeName() });
  return shell.runExternal([python(), path.join(__dirname, 'gemma.py'), ...args], io, env);
}

module.exports = { runSage, HELP, ready, pick, fallback, freeMemory, recent, MODELS, DEFAULT, REPO, FILES };
