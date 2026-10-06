'use strict';

// aig: chat with Gemma 4 (E4B, or E2B with --e2b), Google's open model, on
// this Mac. The model runs in src/gemma.py under its own Python
// (~/.maxshell/gemma/venv: the system PyTorch plus transformers); `aig
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
  e2b: { name: 'E2B', repo: 'leon-se/gemma-4-E2B-it-FP8-Dynamic', sub: '', size: '9 GB' },
  e4b: { name: 'E4B', repo: 'leon-se/gemma-4-E4B-it-FP8-Dynamic', sub: 'e4b', size: '13 GB' },
};
const DEFAULT = 'e4b';
const REPO = MODELS[DEFAULT].repo;
const FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'];

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = (m = MODELS[DEFAULT]) => path.join(base(), m.sub);
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(base(), 'venv', 'bin', 'python');
const ready = (m = MODELS[DEFAULT]) => fs.existsSync(python()) && fs.existsSync(path.join(dir(m), 'model.safetensors')) && FILES.every((f) => fs.existsSync(path.join(dir(m), f)));

// --e2b / --e4b at the front of the arguments, else $MAXSHELL_AIG_MODEL, else E4B.
function pick(args) {
  const flag = /^--(e2b|e4b)$/i.exec(args[0] || '');
  if (flag) args = args.slice(1);
  const key = (flag ? flag[1] : process.env.MAXSHELL_AIG_MODEL || DEFAULT).toLowerCase();
  return { model: MODELS[key], key, args };
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
    if (!py) { err('aig: Gemma needs Python 3.10 or newer — install it (brew install python, or python.org) and run aig --setup again\n'); return 1; }
    write(`Making a Python for Gemma from ${py}…\n`);
    if (!run(py, ['-m', 'venv', '--system-site-packages', venv])) { err('aig: couldn’t make the venv\n'); return 1; }
  }
  const hasTorch = spawnSync(python(), ['-c', 'import torch'], { stdio: 'ignore' }).status === 0;
  write(hasTorch ? 'Installing transformers…\n' : 'Installing PyTorch and transformers…\n');
  if (!run(python(), ['-m', 'pip', 'install', '-q', 'transformers>=5.5', ...(hasTorch ? [] : ['torch'])])) { err('aig: pip install failed\n'); return 1; }
  write(`Fetching the config and tokenizer from ${m.repo}…\n`);
  const fetch = (files) => `from huggingface_hub import hf_hub_download\nfor f in ${JSON.stringify(files)}:\n    hf_hub_download(${JSON.stringify(m.repo)}, f, local_dir='.')\n`;
  if (spawnSync(python(), ['-c', fetch(FILES)], { cwd: d, stdio: 'inherit' }).status !== 0) { err('aig: download failed\n'); return 1; }
  const model = path.join(d, 'model.safetensors');
  if (!fs.existsSync(model)) {
    write(`Downloading ${m.repo}'s model.safetensors (${m.size}) into ${d}…\n`);
    if (spawnSync(python(), ['-c', fetch(['model.safetensors'])], { cwd: d, stdio: 'inherit' }).status !== 0) { err('aig: download failed\n'); return 1; }
  }
  write(`Gemma 4 (${m.name}) is ready — try: aig${m === MODELS[DEFAULT] ? '' : ' --' + m.name.toLowerCase()}\n`);
  return 0;
}

function runAig(args, io, shell) {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  const { model: m, key, args: rest } = pick(args);
  if (!m) { err(`aig: no Gemma model ${key} — e2b or e4b\n`); return 1; }
  args = rest;
  const flag = m === MODELS[DEFAULT] ? '' : ` --${key}`;
  if (args[0] === '--setup') return setup(m, write, err);
  if (args[0] === '--help' || args[0] === '-h') {
    write('aig — chat with Gemma 4 on this Mac\n  aig              chat (bye to leave, Ctrl-C stops an answer)\n  aig <question>   one answer\n  aig --e2b …      use E2B, the smaller, faster model (MAXSHELL_AIG_MODEL=e2b makes it the default)\n  aig --setup      install what it needs (aig --e2b --setup for E2B)\n');
    return 0;
  }
  if (!ready(m)) { err(`aig: Gemma 4 (${m.name}) isn’t set up — run: aig${flag} --setup\n`); return 1; }
  const t = theme.current();
  const colors = {
    accent: ansi.fg(t.ui.accent), accent2: ansi.fg(t.ui.accent2), muted: ansi.fg(t.ui.muted),
    bold: ansi.bold(), reset: ansi.reset(),
  };
  // gemma.py renders replies with src/markdown.js, run by this Node in this theme.
  const env = {
    ...shell.env, MAXSHELL_AIG_COLORS: JSON.stringify(colors), MAXSHELL_GEMMA: dir(m), MAXSHELL_AIG_NAME: m.name,
    MAXSHELL_NODE: process.execPath, MAXSHELL_THEME: theme.currentThemeName(),
  };
  if (!env.MAXSHELL_AIG_DEVICE && training()) env.MAXSHELL_AIG_DEVICE = 'cpu';
  return shell.runExternal([python(), path.join(__dirname, 'gemma.py'), ...args], io, env);
}

module.exports = { runAig, ready, pick, recent, MODELS, DEFAULT, REPO, FILES };
