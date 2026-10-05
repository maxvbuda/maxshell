'use strict';

// aig: chat with Gemma 4 (E2B), Google's open model, on this Mac. The model
// runs in src/gemma.py under its own Python (~/.maxshell/gemma/venv: the
// system PyTorch plus transformers); `aig --setup` makes that Python, fetches
// the model's config and tokenizer, and links the model file from
// ~/Downloads. While mx training has the GPU, Gemma runs on the CPU, which
// is as fast then and doesn't slow the training.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The FP8 build of Gemma 4 E2B (instruction-tuned) — the model.safetensors
// that's in ~/Downloads; its config and tokenizer come from the same repo.
const REPO = 'leon-se/gemma-4-E2B-it-FP8-Dynamic';
const FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'];

const dir = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(dir(), 'venv', 'bin', 'python');
const ready = () => fs.existsSync(python()) && fs.existsSync(path.join(dir(), 'model.safetensors')) && FILES.every((f) => fs.existsSync(path.join(dir(), f)));
const training = () => spawnSync('pgrep', ['-f', 'ai/mx2/train.py']).status === 0;

function setup(write, err) {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
  if (!fs.existsSync(python())) {
    write('Making a Python for Gemma (uses the system PyTorch)…\n');
    if (!run('python3', ['-m', 'venv', '--system-site-packages', path.join(d, 'venv')])) { err('aig: couldn’t make the venv\n'); return 1; }
  }
  write('Installing transformers…\n');
  if (!run(python(), ['-m', 'pip', 'install', '-q', 'transformers>=5.5'])) { err('aig: pip install failed\n'); return 1; }
  write(`Fetching the config and tokenizer from ${REPO}…\n`);
  const fetch = `import shutil\nfrom huggingface_hub import hf_hub_download\nfor f in ${JSON.stringify(FILES)}:\n    shutil.copy(hf_hub_download(${JSON.stringify(REPO)}, f), f)\n`;
  if (spawnSync(python(), ['-c', fetch], { cwd: d, stdio: 'inherit' }).status !== 0) { err('aig: download failed\n'); return 1; }
  const model = path.join(d, 'model.safetensors');
  if (!fs.existsSync(model)) {
    const found = path.join(os.homedir(), 'Downloads', 'model.safetensors');
    if (!fs.existsSync(found)) { err(`aig: put ${REPO}'s model.safetensors in ~/Downloads (or ${d}) and run aig --setup again\n`); return 1; }
    fs.symlinkSync(found, model);
    write(`Linked ${found}\n`);
  }
  write('Gemma is ready — try: aig\n');
  return 0;
}

function runAig(args, io, shell) {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  if (args[0] === '--setup') return setup(write, err);
  if (args[0] === '--help' || args[0] === '-h') {
    write('aig — chat with Gemma 4 (E2B) on this Mac\n  aig              chat (bye to leave, Ctrl-C stops an answer)\n  aig <question>   one answer\n  aig --setup      install what it needs\n');
    return 0;
  }
  if (!ready()) { err('aig: Gemma isn’t set up — run: aig --setup\n'); return 1; }
  const t = theme.current();
  const colors = {
    accent: ansi.fg(t.ui.accent), accent2: ansi.fg(t.ui.accent2), muted: ansi.fg(t.ui.muted),
    code: theme.style(t.syntax.code), bold: ansi.bold(), reset: ansi.reset(),
  };
  const env = { ...shell.env, MAXSHELL_AIG_COLORS: JSON.stringify(colors), MAXSHELL_GEMMA: dir() };
  if (!env.MAXSHELL_AIG_DEVICE && training()) env.MAXSHELL_AIG_DEVICE = 'cpu';
  return shell.runExternal([python(), path.join(__dirname, 'gemma.py'), ...args], io, env);
}

module.exports = { runAig, ready, REPO, FILES };
