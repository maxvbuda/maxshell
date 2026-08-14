#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Interpreter } = require('../src/interpreter');
const { Lexer } = require('../src/lexer');

const VERSION = require('../package.json').version;

function blockDepth(source) {
  // Depth of unclosed blocks. Count block-openers (if/while/for/fn), each
  // of which needs exactly one closing "end" — except an "if" chained
  // after "else" (an "else if"), which shares its predecessor's "end".
  let depth = 0;
  let prevType = null;
  try {
    const tokens = new Lexer(source).tokenize();
    for (const tok of tokens) {
      if (tok.type === 'NEWLINE') continue;
      if ((tok.type === 'IF' && prevType !== 'ELSE') ||
          tok.type === 'WHILE' || tok.type === 'FOR' || tok.type === 'FN') {
        depth++;
      } else if (tok.type === 'END') {
        depth--;
      }
      prevType = tok.type;
    }
  } catch {
    // Unterminated string etc. — keep prompting for more input.
    return 1;
  }
  return depth;
}

function runFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const interp = new Interpreter();
  try {
    interp.run(source);
  } catch (e) {
    process.stderr.write(`maxshell: ${e.message}\n`);
    process.exit(1);
  }
}

function runRepl() {
  const interp = new Interpreter();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'maxshell> ',
  });

  console.log(`maxshell v${VERSION} — a terminal with its own scripting language`);
  console.log('Type "!<command>" to run a real system command, or MaxScript directly. Ctrl+D to exit.');

  let buffer = '';

  const showPrompt = () => {
    rl.setPrompt(buffer ? '     ...> ' : 'maxshell> ');
    rl.prompt();
  };

  showPrompt();

  rl.on('line', (line) => {
    buffer += (buffer ? '\n' : '') + line;
    if (blockDepth(buffer) > 0) {
      showPrompt();
      return;
    }
    const source = buffer;
    buffer = '';
    try {
      interp.run(source);
    } catch (e) {
      console.error(`error: ${e.message}`);
    }
    showPrompt();
  });

  rl.on('close', () => {
    console.log('');
    process.exit(0);
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 0 && !args[0].startsWith('-')) {
    runFile(path.resolve(args[0]));
    return;
  }
  runRepl();
}

main();
