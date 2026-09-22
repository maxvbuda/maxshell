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
const { leftPrompt, rightPrompt, expandPrompt } = require('../src/prompt');
const ansi = require('../src/ansi');

const VERSION = require('../package.json').version;
const HISTORY_FILE = path.join(os.homedir(), '.maxshell_history');
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

function loadHistory(shell) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    shell.history.push(...lines.slice(-HISTORY_LIMIT));
  } catch { /* history is best-effort */ }
}

function saveHistory(shell) {
  try {
    fs.writeFileSync(HISTORY_FILE, `${shell.history.slice(-HISTORY_LIMIT).join('\n')}\n`);
  } catch { /* history is best-effort */ }
}

function remember(shell, source) {
  const entry = source.replace(/\n/g, '; ').trim();
  if (!entry) return;
  if (shell.history[shell.history.length - 1] === entry) return;
  shell.history.push(entry);
}

function continuationPrompt(shell) {
  return expandPrompt(shell.getVar('PS2') || '%F{gray}   ...>%f ', shell);
}

function banner() {
  const dim = ansi.dim();
  const r = ansi.reset();
  process.stdout.write(
    `${ansi.bold()}maxshell ${VERSION}${r} ${dim}— zsh-flavoured, on Node.js${r}\n`
    + `${dim}help · tab completes · → accepts suggestions · ctrl-c cancels · ctrl-d exits${r}\n`,
  );
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
  });

  banner();
  let buffer = '';

  for (;;) {
    const prompt = buffer ? continuationPrompt(shell) : leftPrompt(shell);
    const rprompt = buffer ? '' : rightPrompt(shell);

    let result;
    try {
      result = await editor.read(prompt, rprompt);
    } catch (e) {
      reportError(e);
      break;
    }

    if (result.eof) break;
    if (result.aborted) { buffer = ''; continue; }

    buffer = buffer ? `${buffer}\n${result.line}` : result.line;
    if (!buffer.trim()) { buffer = ''; continue; }

    try {
      shell.run(buffer);
      remember(shell, buffer);
      buffer = '';
    } catch (e) {
      if (e instanceof IncompleteError) continue;
      remember(shell, buffer);
      buffer = '';
      reportError(e);
    }

    if (shell.exited) break;
  }

  saveHistory(shell);
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

    banner();
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
      saveHistory(shell);
      process.stdout.write('\n');
      resolve(shell.status);
    });
  });
}

async function runRepl() {
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  ansi.setEnabled(!!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb');

  const shell = new Shell({ interactive: true });
  sourceRcFile(shell);
  loadHistory(shell);

  const status = interactive ? await runEditorRepl(shell) : await runPlainRepl(shell);
  process.exit(status);
}

function runSource(src, name, args) {
  ansi.setEnabled(false);
  const shell = new Shell({ name, positional: args });
  try {
    return shell.run(src);
  } catch (e) {
    if (e instanceof ExitSignal) return e.status;
    reportError(e);
    return 1;
  }
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
