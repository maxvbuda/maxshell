#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { Shell, ShellError, IncompleteError, ExitSignal } = require('../src/interpreter');
const { LineEditor } = require('../src/lineeditor');
const { highlight } = require('../src/highlight');
const { completions } = require('../src/complete');
const {
  leftPrompt, rightPrompt, expandPrompt, usesDefaultPrompt, promptParts, compactPrompt, terminalTitle,
} = require('../src/prompt');
const theme = require('../src/theme');
const { banner: logoBanner } = require('../src/banner');
const ansi = require('../src/ansi');
const { History, historyFile } = require('../src/history');
const { DirDB } = require('../src/jump');
const { suggestLine } = require('../src/suggest');
const alerts = require('../src/alerts');

const VERSION = require('../package.json').version;
const RC_FILE = path.join(os.homedir(), '.maxshellrc');
const HISTORY_LIMIT = 2000;

function reportError(e) {
  process.stderr.write(`${ansi.fg('red')}maxshell:${ansi.reset()} ${e.message}\n`);
}

function sourceRcFile(shell) {
  if (!fs.existsSync(RC_FILE)) return;
  try {
    shell.run(fs.readFileSync(RC_FILE, 'utf8'));
  } catch (e) {
    if (!(e instanceof ExitSignal)) reportError(e);
  }
}

// History keeps the folder and time of each command for Ctrl-R. The shell
// also sees the plain command list, which drives ghost suggestions.
const history = new History();

function loadHistory(shell) {
  history.load(historyFile(), HISTORY_LIMIT);
  shell.history.push(...history.commands());
}

function saveHistory() {
  try { history.save(historyFile(), HISTORY_LIMIT); } catch { /* history is best-effort */ }
}

function remember(shell, source) {
  if (history.add(source, shell.cwd)) shell.history.push(history.entries[history.entries.length - 1].cmd);
}

// Seconds a command must run before finishing earns a notification when
// you're in another app. Set NOTIFY_AFTER (or 0 to turn it off).
function notifyThreshold(shell) {
  const v = shell.getVar('NOTIFY_AFTER');
  const n = v === undefined || v === '' ? 10 : Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Infinity;
}

// After each command: a quiet ✓/✗ line when it was slow or failed, and a
// desktop notification when something long finished while you were away.
function afterCommand(shell, source, ms) {
  if (shell.exited) return;
  // A suspended job has already said so.
  if (shell.suspended) { shell.suspended = false; return; }
  const line = alerts.statusLine(shell.status, ms);
  if (line) {
    const color = line.ok ? ansi.fg('green') : ansi.fg('red');
    process.stdout.write(`${color}${line.text.slice(0, 1)}${ansi.reset()}${ansi.fg('gray')}${line.text.slice(1)}${ansi.reset()}\n`);
  }
  const limit = notifyThreshold(shell);
  if (ms >= limit && alerts.shouldNotify(ms, limit, alerts.frontApp())) {
    const what = source.split('\n')[0].slice(0, 60);
    const outcome = shell.status === 0 ? 'finished' : `failed (exit ${shell.status})`;
    alerts.notify('maxshell', `${what} ${outcome} — ${alerts.formatDuration(ms)}`);
  }
}

// A corrected command line to offer after "command not found".
function fixFor(shell, source) {
  const miss = shell.lastNotFound;
  if (!miss || source.includes('\n')) return null;
  const first = source.trim().split(/\s+/)[0];
  if (first !== miss.name) return null;
  return suggestLine(source.trim(), shell);
}

function continuationPrompt(shell) {
  return expandPrompt(shell.getVar('PS2') || '%F{gray}   ...>%f ', shell);
}

// The logo and a tip. BANNER=off in ~/.maxshellrc (or MAXSHELL_BANNER=0)
// turns it off.
function banner(shell) {
  const off = (v) => /^(0|off|no|false)$/i.test(String(v || ''));
  if (off(process.env.MAXSHELL_BANNER) || (shell && off(shell.getVar('BANNER')))) return;
  process.stdout.write(logoBanner({ version: VERSION, cols: process.stdout.columns || 80 }));
}

// Interactive loop backed by the custom line editor.
async function runEditorRepl(shell) {
  const editor = new LineEditor({
    input: process.stdin,
    output: process.stdout,
    shell,
    highlight,
    complete: completions,
    history: shell.history,
    searchHistory: (q) => history.search(q, { cwd: shell.cwd }),
    palette: true,
  });

  // Ctrl-C should stop the running command, not the shell: the child gets
  // the signal from the terminal, and maxshell simply carries on.
  process.on('SIGINT', () => {});

  const dirs = new DirDB();
  dirs.visit(shell.cwd);
  dirs.save();

  banner(shell);
  let buffer = '';
  let fix = null;
  let warnedJobs = false;

  for (;;) {
    // The signature prompt is one line with information on the right; a
    // custom PROMPT uses PROMPT and RPROMPT as given.
    if (!buffer) shell.notifyJobs((t) => process.stdout.write(t));
    const fancy = !buffer && usesDefaultPrompt(shell);
    if (!buffer) process.stdout.write(terminalTitle(shell));
    let prompt;
    let rprompt;
    if (fancy) {
      const parts = promptParts(shell, process.stdout.columns || 80);
      prompt = parts.input;
      rprompt = parts.right;
    } else {
      prompt = buffer ? continuationPrompt(shell) : leftPrompt(shell);
      rprompt = buffer ? '' : rightPrompt(shell);
    }

    let result;
    try {
      const initial = buffer ? '' : shell.prefill || '';
      shell.prefill = null;
      result = await editor.read(prompt, rprompt, { fix: buffer ? null : fix, initial });
    } catch (e) {
      reportError(e);
      break;
    }
    fix = null;

    // Ctrl-P: the palette. What you pick runs as if typed (or, for a
    // snippet or recent command, goes on the line to edit).
    if (result.palette) {
      const item = require('../src/picker').pick(require('../src/palette').paletteItems(shell), { title: 'maxshell — do anything', hint: 'run' });
      const erase = () => process.stdout.write(`\x1b[${editor.lastEndRow + 1}A\r\x1b[J`);
      if (!item) { erase(); shell.prefill = result.line; continue; }
      if (item.insert) { erase(); shell.prefill = item.value; continue; }
      result.line = item.value;
    }
    // Alt-H: explain the line, then hand it back to edit.
    if (result.explain) {
      const { explain } = require('../src/explain');
      process.stdout.write(`${explain(result.line, shell, process.stdout.columns || 80).join('\n')}\n`);
      shell.prefill = result.line;
      continue;
    }
    // Alt-S: save the line as a snippet, asking for a name.
    if (result.saveSnippet) {
      const { Store, snippetsFile, suggestName } = require('../src/snippets');
      const named = await editor.read(`${theme.fg('accent')}snippet name ❯${ansi.reset()} `, '', { initial: suggestName(result.line) });
      const name = (named.line || '').trim().replace(/\s+/g, '-');
      if (!named.aborted && !named.eof && name) {
        new Store(snippetsFile()).set(name, result.line);
        process.stdout.write(`${ansi.fg('gray')}✂ saved ${name} — snip or Ctrl-P brings it back${ansi.reset()}\n`);
      }
      shell.prefill = result.line;
      continue;
    }

    if (result.eof || /^\s*exit(\s|$)/.test(result.line || '')) {
      // Like zsh: the first attempt to leave with suspended jobs only warns.
      const stopped = shell.jobs.filter((j) => { j.poll(); return j.state === 'stopped'; });
      if (stopped.length && !warnedJobs) {
        warnedJobs = true;
        if (result.eof) process.stdout.write('\n');
        process.stdout.write(`${ansi.fg('yellow')}maxshell: you have suspended jobs.${ansi.reset()}\n`);
        continue;
      }
      if (result.eof) break;
    } else warnedJobs = false;
    if (result.aborted) { buffer = ''; continue; }

    // Redraw the finished prompt without its right side, so scrollback reads
    // as a tidy list of commands.
    if (fancy) {
      const up = editor.lastEndRow + 1;
      process.stdout.write(`\x1b[${up}A\r\x1b[J${compactPrompt(shell, result.line, (l) => highlight(l, shell))}\n`);
    }

    buffer = buffer ? `${buffer}\n${result.line}` : result.line;
    if (!buffer.trim()) { buffer = ''; continue; }

    const source = buffer;
    const cwdBefore = shell.cwd;
    shell.lastNotFound = null;
    const started = Date.now();
    try {
      shell.run(source);
      remember(shell, source);
      buffer = '';
    } catch (e) {
      if (e instanceof IncompleteError) continue;
      remember(shell, source);
      buffer = '';
      reportError(e);
    }

    shell.lastDuration = Date.now() - started;
    afterCommand(shell, source, shell.lastDuration);
    fix = fixFor(shell, source);
    if (shell.cwd !== cwdBefore) {
      dirs.visit(shell.cwd);
      dirs.save();
    }
    saveHistory();

    if (shell.exited) break;
  }

  saveHistory();
  shell.runExitTrap();
  // Jobs are hung up when the shell leaves, as a login shell would.
  for (const job of shell.jobs) job.hangup();
  return shell.status;
}

// Fallback for terminals that can't support the editor (no tty on one side).
function runPlainRepl(shell) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let buffer = '';

    const prompt = () => {
      rl.setPrompt(buffer ? '   ...> ' : 'maxshell %# '.replace('%#', '%'));
      rl.prompt();
    };

    banner(shell);
    prompt();

    rl.on('line', (line) => {
      buffer = buffer ? `${buffer}\n${line}` : line;
      if (!buffer.trim()) { buffer = ''; prompt(); return; }
      try {
        shell.run(buffer);
        remember(shell, buffer);
        buffer = '';
      } catch (e) {
        if (e instanceof IncompleteError) { prompt(); return; }
        remember(shell, buffer);
        buffer = '';
        reportError(e);
      }
      if (shell.exited) { rl.close(); return; }
      prompt();
    });

    rl.on('close', () => {
      saveHistory();
      process.stdout.write('\n');
      resolve(shell.status);
    });
  });
}

async function runRepl() {
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  ansi.setEnabled(!!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb');

  theme.loadSavedTheme();
  const shell = new Shell({ interactive: true });
  sourceRcFile(shell);
  loadHistory(shell);

  const status = interactive ? await runEditorRepl(shell) : await runPlainRepl(shell);
  process.exit(status);
}

function runSource(src, name, args) {
  ansi.setEnabled(false);
  const shell = new Shell({ name, positional: args });
  let status;
  try {
    status = shell.run(src);
  } catch (e) {
    if (e instanceof ExitSignal) status = e.status;
    else { reportError(e); status = 1; }
  }
  shell.status = status;
  shell.runExitTrap();
  return status;
}

function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`maxshell ${VERSION}\n`);
    return;
  }

  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(
      'usage: maxshell [script [args...]]\n'
      + '       maxshell -c "command"\n'
      + '       maxshell            start an interactive shell\n',
    );
    return;
  }

  if (argv[0] === '-c') {
    if (argv[1] === undefined) {
      process.stderr.write('maxshell: -c requires an argument\n');
      process.exit(2);
    }
    process.exit(runSource(argv[1], 'maxshell', argv.slice(2)));
  }

  if (argv.length && !argv[0].startsWith('-')) {
    const file = path.resolve(argv[0]);
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      process.stderr.write(`maxshell: cannot read ${argv[0]}\n`);
      process.exit(127);
    }
    process.exit(runSource(src, argv[0], argv.slice(1)));
  }

  if (!process.stdin.isTTY) {
    process.exit(runSource(fs.readFileSync(0, 'utf8'), 'maxshell', []));
  }

  runRepl();
}

main();
