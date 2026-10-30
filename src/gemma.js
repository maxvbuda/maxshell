'use strict';

// sage: Sage, maxshell's AI, on this Mac. Every model is a 4-bit build run
// with Apple's MLX on the GPU, in src/sage.py under Sage's own Python
// (~/.maxshell/gemma/venv, with mlx-lm); `sage --setup` makes that Python and
// downloads the model into its folder. The full-screen app is src/sage.js.
// Chosen by testing on this Mac (24 GB, M3) against sums and facts for chat
// and small read-edit-run tasks for sage code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The models, best first. Sage Ultra, Pro and Flash are the same in chat and
// sage code; Sage Lite is a different small model for each.
const MODELS = {
  // Alibaba's Qwen3.8-27B: the strongest model that fits this Mac's GPU, all
  // 27B parameters used for every token, and it thinks before it answers —
  // slow, but the most power.
  ultra: {
    name: 'ULTRA', label: 'Sage Ultra', flag: 'ultra', repo: 'mlx-community/Qwen3.8-27B-4bit', sub: 'ultra',
    size: '16 GB', needFree: 60,
  },
  // Pro and Flash are Google's Gemma 4.
  e4b: { name: 'E4B', label: 'Sage Pro', flag: 'pro', repo: 'mlx-community/gemma-4-e4b-it-4bit', sub: 'pro', size: '5.2 GB', needFree: 30 },
  e2b: { name: 'E2B', label: 'Sage Flash', flag: 'flash', repo: 'mlx-community/gemma-4-e2b-it-4bit', sub: 'flash', size: '3.3 GB', needFree: 20 },
  // Lite in a chat: Alibaba's Qwen3-1.7B, thinking off — about 50 tokens a
  // second, and right on sums where smaller models weren't.
  lite: { name: 'LITE', label: 'Sage Lite', flag: 'lite', repo: 'mlx-community/Qwen3-1.7B-4bit', sub: 'lite', size: '1 GB', needFree: 10 },
  // Lite in sage code: Mistral's Ministral 3 3B, the smallest that reliably
  // reads before it edits.
  litecode: {
    name: 'LITE-CODE', label: 'Sage Lite', flag: 'lite', repo: 'mlx-community/Ministral-3-3B-Instruct-2512-4bit', sub: 'lite-code',
    size: '2.6 GB', needFree: 15,
  },
};
const DEFAULT = 'e4b';
const REPO = MODELS[DEFAULT].repo;
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];

const base = () => process.env.MAXSHELL_GEMMA || path.join(os.homedir(), '.maxshell', 'gemma');
const dir = (m = MODELS[DEFAULT]) => path.join(base(), m.sub);
const python = () => process.env.MAXSHELL_GEMMA_PYTHON || path.join(base(), 'venv', 'bin', 'python');
// mlx-lm, which runs the models, in Sage's Python.
function hasMlx() {
  const lib = path.join(path.dirname(path.dirname(python())), 'lib');
  try { return fs.readdirSync(lib).some((v) => fs.existsSync(path.join(lib, v, 'site-packages', 'mlx_lm'))); } catch { return false; }
}
// The weights: the shards the index lists, or one file.
function weights(m) {
  try {
    return [...new Set(Object.values(JSON.parse(fs.readFileSync(path.join(dir(m), 'model.safetensors.index.json'), 'utf8')).weight_map))];
  } catch { return ['model.safetensors']; }
}
const ready = (m = MODELS[DEFAULT]) => fs.existsSync(python()) && [...FILES, ...weights(m)].every((f) => fs.existsSync(path.join(dir(m), f)))
  && (!!process.env.MAXSHELL_GEMMA_PYTHON || hasMlx());

// --ultra / --pro / --flash / --lite (or --e4b / --e2b) at the front of the
// arguments, else $MAXSHELL_SAGE_MODEL, else Pro.
const ALIASES = { flash: 'e2b', pro: 'e4b' };
function pick(args) {
  const flag = /^--(e2b|e4b|flash|lite|pro|ultra)$/i.exec(args[0] || '');
  if (flag) args = args.slice(1);
  let key = (flag ? flag[1] : process.env.MAXSHELL_SAGE_MODEL || DEFAULT).toLowerCase();
  key = ALIASES[key] || key;
  return { model: MODELS[key], key, args, chosen: !!(flag || process.env.MAXSHELL_SAGE_MODEL), flagged: !!flag };
}
// Sage Lite is a chat model in a chat and a coding model in sage code.
const modelFor = (key, mode) => (key === 'lite' && mode === 'code' ? MODELS.litecode : MODELS[key]);

// % of memory free — on a Mac the GPU's memory is the same memory.
// MAXSHELL_SAGE_FREE stands in for it in tests.
function freeMemory() {
  if (process.env.MAXSHELL_SAGE_FREE) return Number(process.env.MAXSHELL_SAGE_FREE);
  const n = parseInt(spawnSync('sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' }).stdout, 10);
  return Number.isFinite(n) ? n : 100;
}

// When no model was asked for and there isn't room for Pro, Flash (if it's
// set up) instead: { key, why }.
function fallback(key, chosen) {
  if (chosen || key !== 'e4b' || !ready(MODELS.e2b)) return { key };
  const free = freeMemory();
  if (free >= MODELS.e4b.needFree) return { key };
  return { key: 'e2b', why: `Only ${free}% of memory is free and Sage Pro needs ${MODELS.e4b.needFree}%, so this is Sage Flash, the lighter model.` };
}

// mlx-lm needs Python 3.10+; macOS's /usr/bin/python3 is 3.9.
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
  // A venv made from a Python older than 3.10 (macOS's own is 3.9) can't run
  // mlx-lm; it's ours, so make it again.
  if (fs.existsSync(python()) && !recent(python()) && !process.env.MAXSHELL_GEMMA_PYTHON) {
    write('Sage’s Python is too old — making it again…\n');
    fs.rmSync(venv, { recursive: true, force: true });
  }
  if (!fs.existsSync(python())) {
    const py = findPython();
    if (!py) { err('sage: Sage needs Python 3.10 or newer — install it (brew install python, or python.org) and run sage --setup again\n'); return 1; }
    write(`Making a Python for Sage from ${py}…\n`);
    if (!run(py, ['-m', 'venv', '--system-site-packages', venv])) { err('sage: couldn’t make the venv\n'); return 1; }
  }
  write('Installing mlx-lm…\n');
  // 0.32 runs Gemma 4 and Ministral 3
  if (!run(python(), ['-m', 'pip', 'install', '-q', 'mlx-lm>=0.32', 'transformers>=5.5'])) { err('sage: pip install failed\n'); return 1; }
  write(`Downloading ${m.repo} (${m.size}) into ${d}…\n`);
  const snap = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(m.repo)}, local_dir='.', allow_patterns=['*.json', '*.safetensors', '*.txt', '*.jinja'])\n`;
  if (spawnSync(python(), ['-c', snap], { cwd: d, stdio: 'inherit', env: { ...hubEnv(), HF_HUB_DISABLE_XET: '1' } }).status !== 0) { err('sage: download failed\n'); return 1; }
  write(`${m.label} is ready — try: sage${m === MODELS.litecode ? ' code' : ''}${m === MODELS[DEFAULT] ? '' : ` --${m.flag}`}\n`);
  return 0;
}

// What the engine is told: which model, and where it is.
const engineEnv = (m, shell) => ({ ...shell.env, MAXSHELL_GEMMA: dir(m), MAXSHELL_SAGE_NAME: m.name, MAXSHELL_NODE: process.execPath });

// sage image's and sage video's prompt writer: Sage Lite, so it loads in a
// moment and leaves the memory to the image model (Sage Pro, or Flash when
// memory is short, if Lite isn't set up), as a command that turns a request
// into a detailed prompt — { label, cmd, env } — or null when none is set up.
function promptWriter(shell) {
  const fake = process.env.MAXSHELL_SAGE_WRITER; // tests: a stand-in for sage.py
  if (fake) return { label: 'Sage Lite', cmd: [process.execPath, fake], env: {} };
  if (ready(MODELS.lite)) return { label: MODELS.lite.label, cmd: [python(), path.join(__dirname, 'sage.py')], env: engineEnv(MODELS.lite, shell) };
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
  sage --continue      pick up your last chat, remembered (sage code --continue:
                       the last session in this folder; /resume in the app)
  sage app             Sage for Mac: the same, as a Mac app (built here the
                       first time, into ~/Applications; --build rebuilds it)
  sage code [task]     Sage Code: a coding agent that reads, writes and edits
                       files and runs commands here — each one asked first
  sage --ultra …       use Sage Ultra, the smartest (needs ~16 GB of memory)
  sage --flash …       use Sage Flash, twice as fast as Pro (MAXSHELL_SAGE_MODEL=flash
                       makes it the default; Sage Pro is, unless memory is short)
  sage --lite …        use Sage Lite, tiny and the fastest of all
  sage --setup         install what it needs (sage --ultra --setup for Sage Ultra,
                       sage --flash --setup, sage --lite --setup, and
                       sage code --lite --setup for Sage Code's Lite)
`;

// --- Sage for Mac (mac/: SwiftUI, built by mac/build.sh with SwiftPM) ---------

const appPath = () => path.join(process.env.SAGE_APP_DIR || path.join(os.homedir(), 'Applications'), 'Sage.app');

// Whether the app is missing or older than its sources (or the bridge it runs).
function appStale(app = appPath(), mac = path.join(__dirname, '..', 'mac')) {
  let built;
  try { built = fs.statSync(path.join(app, 'Contents', 'MacOS', 'Sage')).mtimeMs; } catch { return true; }
  const newest = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return 0; }
    if (!st.isDirectory()) return st.mtimeMs;
    return Math.max(0, ...fs.readdirSync(p).filter((n) => n !== '.build').map((n) => newest(path.join(p, n))));
  };
  return newest(mac) > built;
}

function runApp(args, write, err) {
  if (args[0] === '--help' || args[0] === '-h') {
    write('sage app — Sage for Mac: chat, code, pictures and clips in a Mac app.\n  sage app          open it (built into ~/Applications the first time)\n  sage app --build  build it again\n');
    return 0;
  }
  const app = appPath();
  if (args[0] === '--build' || appStale(app)) {
    if (spawnSync('swift', ['--version'], { stdio: 'ignore' }).status !== 0) {
      err('sage app: building it needs Swift — install Apple’s command line tools: xcode-select --install\n');
      return 1;
    }
    write(`Building Sage for Mac into ${app.replace(os.homedir(), '~')} (about a minute)…\n`);
    const r = spawnSync('/bin/sh', [path.join(__dirname, '..', 'mac', 'build.sh')], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { err('sage app: the build failed\n'); return 1; }
  }
  if (!process.env.MAXSHELL_IMAGE_NO_OPEN) spawnSync('open', [app], { stdio: 'ignore' });
  write(`Sage for Mac is open (${app.replace(os.homedir(), '~')}).\n`);
  return 0;
}

function runSage(args, io, shell, name = 'sage') {
  const ansi = require('./ansi');
  const theme = require('./theme');
  const write = (s) => shell.writeTo(io.stdout, s);
  const err = (s) => shell.writeTo(io.stderr, s);
  let mode = 'chat';
  if (args[0] === '--setup' && args.length > 1) args = [...args.slice(1), '--setup']; // sage --setup --lite is sage --lite --setup
  if (/^--(flash|lite)$/.test(args[0]) && args[1] === 'image') args = ['image', args[0], ...args.slice(2)]; // sage --flash image is sage image --flash
  if (args[0] === 'image') return require('./sageimage').runImage(args.slice(1), io, shell);
  if (args[0] === 'video') return require('./sagevideo').runVideo(args.slice(1), io, shell);
  if (args[0] === 'app') return runApp(args.slice(1), write, err);
  if (args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  let cont = false; // --continue, among the flags at the front
  for (let i = 0; i < 3 && i < args.length; i++) {
    if (args[i] === '--continue' || args[i] === '-c') { cont = true; args = [...args.slice(0, i), ...args.slice(i + 1)]; break; }
  }
  if (args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  let { model: m, key, args: rest, chosen } = pick(args);
  if (!m) { err(`${name}: no model ${key} — ultra, pro, flash or lite\n`); return 1; }
  args = rest;
  if (mode === 'chat' && args[0] === 'code') { mode = 'code'; args = args.slice(1); }
  // --continue: pick up the last conversation (sage code: in this folder)
  const resume = cont ? require('./conversations').latest(mode, mode === 'code' ? shell.cwd : null) : null;
  if (cont && !resume) err(`${name}: no earlier ${mode === 'code' ? 'session in this folder' : 'chat'} — starting a new one\n`);
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
    const app = new sage.SageApp({ mode, root: shell.cwd, model: key, models, start, ask: args.length ? args.join(' ') : null, notice: auto.why, startImage, resume });
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

module.exports = { appStale, runApp, promptWriter, runSage, HELP, ready, pick, modelFor, fallback, freeMemory, recent, MODELS, DEFAULT, REPO, FILES };
