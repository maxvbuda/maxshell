'use strict';

// aig: chat with Gemma 4 (E2B, or E4B with --e4b), Google's open model, on
// this Mac. The model runs in src/gemma.py under its own Python
// (~/.maxshell/gemma/venv: the system PyTorch plus transformers); `aig
// --setup` makes that Python, fetches the model's config and tokenizer, and
// links E2B's model file from ~/Downloads (E4B's is downloaded). While mx training has the GPU, Gemma runs on the CPU, which
// is as fast then and doesn't slow the training.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The FP8 builds of Gemma 4 (instruction-tuned). E2B lives in the gemma
// folder itself (its model.safetensors is the one in ~/Downloads); E4B, about
// twice the compute and memory, lives in gemma/e4b.
const MODELS = {
  e2b: { name: 'E2B', repo: 'leon-se/gemma-4-E2B-it-FP8-Dynamic', sub: '' },
  e4b: { name: 'E4B', repo: 'leon-se/gemma-4-E4B-it-FP8-Dynamic', sub: 'e4b' },
};
const REPO = MODELS.e2b.repo;
const FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'];

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = (m = MODELS.e2b) => path.join(base(), m.sub);
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(base(), 'venv', 'bin', 'python');
const ready = (m = MODELS.e2b) => fs.existsSync(python()) && fs.existsSync(path.join(dir(m), 'model.safetensors')) && FILES.every((f) => fs.existsSync(path.join(dir(m), f)));

// --e2b / --e4b at the front of the arguments, else $MAXSHELL_AIG_MODEL, else E2B.
function pick(args) {
  const flag = /^--(e2b|e4b)$/i.exec(args[0] || '');
  if (flag) args = args.slice(1);
  const key = (flag ? flag[1] : process.env.MAXSHELL_AIG_MODEL || 'e2b').toLowerCase();
  return { model: MODELS[key], key, args };
}
const training = () => spawnSync('pgrep', ['-f', 'ai/mx2/train.py']).status === 0;

function setup(m, write, err) {
  const d = dir(m);
  fs.mkdirSync(d, { recursive: true });
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
  if (!fs.existsSync(python())) {
    write('Making a Python for Gemma (uses the system PyTorch)…\n');
    if (!run('python3', ['-m', 'venv', '--system-site-packages', path.join(base(), 'venv')])) { err('aig: couldn’t make the venv\n'); return 1; }
  }
  write('Installing transformers…\n');
  if (!run(python(), ['-m', 'pip', 'install', '-q', 'transformers>=5.5'])) { err('aig: pip install failed\n'); return 1; }
  write(`Fetching the config and tokenizer from ${m.repo}…\n`);
  const fetch = (files) => `from huggingface_hub import hf_hub_download\nfor f in ${JSON.stringify(files)}:\n    hf_hub_download(${JSON.stringify(m.repo)}, f, local_dir='.')\n`;
  if (spawnSync(python(), ['-c', fetch(FILES)], { cwd: d, stdio: 'inherit' }).status !== 0) { err('aig: download failed\n'); return 1; }
  const model = path.join(d, 'model.safetensors');
  if (!fs.existsSync(model) && m !== MODELS.e2b) {
    write(`Downloading ${m.repo}'s model.safetensors (13 GB)…\n`);
    if (spawnSync(python(), ['-c', fetch(['model.safetensors'])], { cwd: d, stdio: 'inherit' }).status !== 0) { err('aig: download failed\n'); return 1; }
  } else if (!fs.existsSync(model)) {
    const found = path.join(os.homedir(), 'Downloads', 'model.safetensors');
    if (!fs.existsSync(found)) { err(`aig: put ${m.repo}'s model.safetensors in ~/Downloads (or ${d}) and run aig --setup again\n`); return 1; }
    fs.symlinkSync(found, model);
    write(`Linked ${found}\n`);
  }
  write(`Gemma 4 (${m.name}) is ready — try: aig${m === MODELS.e2b ? '' : ' --' + m.name.toLowerCase()}\n`);
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
  const flag = m === MODELS.e2b ? '' : ` --${key}`;
  if (args[0] === '--setup') return setup(m, write, err);
  if (args[0] === '--help' || args[0] === '-h') {
    write('aig — chat with Gemma 4 on this Mac\n  aig              chat (bye to leave, Ctrl-C stops an answer)\n  aig <question>   one answer\n  aig --e4b …      use E4B, the bigger model (MAXSHELL_AIG_MODEL=e4b makes it the default)\n  aig --setup      install what it needs (aig --e4b --setup for E4B)\n');
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

module.exports = { runAig, ready, pick, MODELS, REPO, FILES };
