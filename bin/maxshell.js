#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { Shell, ShellError, IncompleteError, ExitSignal } = require('../src/interpreter');
const { BUILTINS, findInPath } = require('../src/builtins');

const VERSION = require('../package.json').version;
const HISTORY_FILE = path.join(os.homedir(), '.maxshell_history');
const RC_FILE = path.join(os.homedir(), '.maxshellrc');

function expandPrompt(template, shell) {
  const home = shell.getVar('HOME') || os.homedir();
  return template.replace(/%(.)/g, (match, code) => {
    switch (code) {
      case '~': return shell.cwd.startsWith(home) ? `~${shell.cwd.slice(home.length)}` : shell.cwd;
      case 'd': case '/': return shell.cwd;
      case 'c': case 'C': return path.basename(shell.cwd);
      case 'n': return os.userInfo().username;
      case 'm': return os.hostname().split('.')[0];
      case 'M': return os.hostname();
      case '#': return process.getuid && process.getuid() === 0 ? '#' : '%';
      case '?': return String(shell.status);
      case '%': return '%';
      default: return match;
    }
  });
}

function reportError(e) {
  if (e instanceof ShellError) process.stderr.write(`maxshell: ${e.message}\n`);
  else process.stderr.write(`maxshell: ${e.message}\n`);
}

function sourceRcFile(shell) {
  if (!fs.existsSync(RC_FILE)) return;
  try {
    shell.run(fs.readFileSync(RC_FILE, 'utf8'));
  } catch (e) {
    if (!(e instanceof ExitSignal)) reportError(e);
  }
}

function completer(line, shell) {
  const match = /(\S*)$/.exec(line);
  const partial = match ? match[1] : '';
  const isFirstWord = line.slice(0, line.length - partial.length).trim() === '';

  const candidates = [];

  if (isFirstWord) {
    candidates.push(...Object.keys(BUILTINS), ...shell.funcs.keys(), ...shell.aliases.keys());
    for (const dir of (shell.env.PATH || '').split(':').filter(Boolean)) {
      try {
        for (const name of fs.readdirSync(dir)) candidates.push(name);
      } catch { /* unreadable PATH entry */ }
    }
  }

  const slash = partial.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : partial.slice(0, slash + 1);
  const basePart = slash === -1 ? partial : partial.slice(slash + 1);
  try {
    const dir = dirPart ? shell.resolve(dirPart) : shell.cwd;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.startsWith(basePart)) continue;
      candidates.push(dirPart + entry.name + (entry.isDirectory() ? '/' : ''));
    }
  } catch { /* not a directory */ }

  const hits = [...new Set(candidates)].filter((c) => c.startsWith(partial)).sort();
  return [hits.length ? hits : [], partial];
}

function runRepl() {
  const shell = new Shell({ interactive: true });
  shell.setVar('PROMPT', shell.getVar('PROMPT') || 'maxshell %~ %# ');
  sourceRcFile(shell);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line) => completer(line, shell),
    historySize: 1000,
  });

  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      shell.history.push(...lines);
      rl.history = lines.slice(-1000).reverse();
    }
  } catch { /* no usable history */ }

  process.stdout.write(`maxshell ${VERSION} — a zsh-flavoured shell on Node.js. Type 'help' for the language, Ctrl+D to exit.\n`);

  let buffer = '';

  const prompt = () => {
    const template = buffer
      ? (shell.getVar('PS2') || '%_> ').replace('%_', '   ...')
      : (shell.getVar('PROMPT') || shell.getVar('PS1') || 'maxshell %~ %# ');
    rl.setPrompt(buffer ? '   ...> ' : expandPrompt(template, shell));
    rl.prompt();
  };

  prompt();

  rl.on('line', (line) => {
    buffer = buffer ? `${buffer}\n${line}` : line;

    if (buffer.trim() === '') { buffer = ''; prompt(); return; }

    const source = buffer;
    try {
      shell.history.push(source.replace(/\n/g, '; '));
      shell.run(source);
      buffer = '';
    } catch (e) {
      if (e instanceof IncompleteError) { prompt(); return; }
      buffer = '';
      if (e instanceof ExitSignal) { rl.close(); return; }
      reportError(e);
    }
    prompt();
  });

  rl.on('SIGINT', () => {
    buffer = '';
    process.stdout.write('\n');
    prompt();
  });

  rl.on('close', () => {
    try {
      fs.writeFileSync(HISTORY_FILE, `${shell.history.slice(-1000).join('\n')}\n`);
    } catch { /* history is best-effort */ }
    process.stdout.write('\n');
    process.exit(shell.status);
  });
}

function runSource(src, name, args) {
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
