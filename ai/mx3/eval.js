#!/usr/bin/env node
'use strict';

// mx3's exam, beyond ai/eval.js (which scores everyday questions):
//
//  code     — asks for programs in words the training data didn't use, runs
//             the code mx3 writes, and checks what it prints. Some tasks were
//             in training (new wording), some never were (does it generalize?)
//  website  — asks for a site and validates the HTML
//  checker  — mx3's yes/no verdict on hand-labelled answers, including the
//             mix-ups that made mx2 look random
//
//   node ai/mx3/eval.js [-v]
//   MAXSHELL_AI_MODEL_DIR=… to test an exported checkpoint

process.env.MAXSHELL_AI = process.env.MAXSHELL_AI || 'mx3';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('../../src/ai');
const { validateHtml } = require('../mx2/validate');

const verbose = process.argv.includes('-v');
let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

function codeFrom(text, lang) {
  const blocks = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  const b = blocks.find((m) => m[1] === lang) || blocks[0];
  return b ? b[2] : null;
}

function run(lang, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx3e-'));
  const file = path.join(dir, lang === 'python' ? 'p.py' : 'p.js');
  fs.writeFileSync(file, code);
  const r = spawnSync(lang === 'python' ? 'python3' : 'node', [file], { encoding: 'utf8', timeout: 10000, input: 'Ada\n', env: { ...process.env, NO_COLOR: '1' } });
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.status ? (r.stderr || '').split('\n').slice(-3).join(' ') : '') };
}

// [request, language, what the output should show, seen in training?]
const CODE = [
  ['Write me a Python function to tell if a number is prime', 'python', /2, 3, 5, 7/, true],
  ['javascript: reverse a string please', 'javascript', /dlrow olleh|\w{4,}/, true],
  ['I want python code that counts the vowels in a word', 'python', /\d/, true],
  ['give me a javascript function for the factorial of a number', 'javascript', /120/, true],
  ['python program for fizzbuzz', 'python', /FizzBuzz/, true],
  ['how can I sort a list of numbers in javascript', 'javascript', /3, 7, 19|\d+, \d+/, true],
  ['python code to check if a word is a palindrome', 'python', /True/, true],
  ['javascript function that adds two numbers together', 'javascript', /5/, true],
  ['make a class for a dog in python', 'python', /woof/i, true],
  ['convert celsius to fahrenheit with javascript', 'javascript', /212/, true],
  ['in python, how do I remove duplicates from a list', 'python', /\[/, true],
  ['write a python function that finds the biggest number in a list', 'python', /\d/, true],
  // Never in training:
  ['write a python function that returns the cube of a number', 'python', /27|8|64|125/, false],
  ['write a javascript function that multiplies two numbers', 'javascript', /\d/, false],
  ['python function to convert kilometres to miles', 'python', /\d/, false],
  ['write a javascript function that checks if a number is odd', 'javascript', /true|false/, false],
  ['python code to add up all the even numbers in a list', 'python', /\d/, false],
  ['write a python function that counts the words that start with a capital letter', 'python', /\d/, false],
];

// [question, answer, does it fit?]
const CHECKS = [
  ['what is html', 'HTML (HyperText Markup Language) is the language that describes the content and structure of a web page.', true],
  ['what is html', '`html` is a command that does this: manipulate archives.', false],
  ['can we be friends', 'Of course! 😊 I’m always here in your terminal when you want to chat or build something.', true],
  ['can we be friends', 'It’s 7: Join clubs or activities you enjoy, ask people questions about themselves, and say yes when they invite you.', false],
  ['explain recursion', 'Recursion is when a function calls itself to solve a smaller version of the same problem.', true],
  ['explain recursion', '`explain` is built into maxshell: what a command line will do.', false],
  ['Can you code?', 'Yes! I can write Python, JavaScript and a few other languages. What do you want to make?', true],
  ['Can you code?', 'I’m sorry you’re feeling sad. 💙 Want me to say something nice?', false],
  ['what should i eat for dinner', 'How about pasta with tomato sauce — quick and easy? Or a stir-fry with whatever vegetables you have.', true],
  ['what should i eat for dinner', 'Aredentiy iny is. I’m not sure. I can’t look things up.', false],
  ['who was albert einstein', 'Albert Einstein (1879–1955) was a German-born physicist, one of the most important scientists ever.', true],
  ['who was albert einstein', 'Neil Armstrong with 20 July 201 is a command that does this.', false],
  ['how do i copy a file', 'Run `cp source destination`. Add `-r` to copy a whole folder.', true],
  ['how do i copy a file', 'Why did the developer go broke? Because he used up all his cache. 💸', false],
  ['write a poem about the sea', 'The sea rolls in with silver light,\nit hums its song all day and night;', true],
  ['write a poem about the sea', 'Here’s how to center a div in CSS: use flexbox.', false],
  ['what is the capital of france', 'The capital of France is Paris.', true],
  ['what is the capital of france', 'The capital of Japan is Tokyo.', false],
  ['reverse a string in python', 'Sure! In Python:\n\n```python\ndef reverse(text):\n    return text[::-1]', true],
  ['reverse a string in python', 'This does it:\n\n```python\nimport secrets\nimport string\n\ndef make_password(length=16):', false],
  ['how are you', 'I’m doing well, thanks for asking! How about you?', true],
  ['how are you', 'The capital of Kenya is Nairobi.', false],
  ['tell me a joke', 'Why do programmers prefer dark mode? Because light attracts bugs. 🐛', true],
  ['tell me a joke', 'Press ⌘⇧3 for the whole screen, ⌘⇧4 to drag a box.', false],
  ['what is a variable', 'A variable is a name that stores a value so you can use it later, like a labelled box.', true],
  ['what is a variable', 'the a name stores value box so labelled a later is like it use can you variable A', false],
];

function main() {
  const { tok, model } = ai.load();
  const t0 = Date.now();
  let seen = 0; let seenRun = 0; let seenOk = 0; let fresh = 0; let freshRun = 0; let freshOk = 0;
  for (const [ask, lang, want, inTraining] of CODE) {
    const text = ai.checkedReply([['user', ask]], { rand }).text;
    const code = codeFrom(text, lang);
    const r = code ? run(lang, code) : { ok: false, out: '(no code)' };
    const good = r.ok && want.test(r.out);
    if (inTraining) { seen++; seenRun += r.ok; seenOk += good; } else { fresh++; freshRun += r.ok; freshOk += good; }
    if (verbose) console.log(`${good ? '✓' : r.ok ? '~' : '✗'} [code${inTraining ? '' : ', new'}] ${ask}\n    → ${r.out.trim().replace(/\n/g, ' ⏎ ').slice(0, 140)}`);
  }
  const site = ai.checkedReply([['user', 'make a website for my coffee shop called Bean There']], { rand }).text;
  const html = codeFrom(site, 'html');
  const siteProblem = html ? validateHtml(html) : 'no HTML';
  if (verbose) console.log(`${siteProblem ? '✗' : '✓'} [website] ${siteProblem || 'valid'}${html && !/Bean There/.test(html) ? ' (but not named Bean There)' : ''}`);

  // The checker: how sure is mx3 that each answer fits?
  let right = 0;
  for (const [q, a, fits] of CHECKS) {
    const S = tok.special;
    const ids = ai.promptTokens(tok, ai.contextLine(new Date(2026, 8, 29, 10, 15)), [['user', q]], model.config.ctx - 64);
    model.reset();
    model.feed([...ids, ...tok.encode(a)]);
    const l = model.feed([S['<|end|>'], S['<|sys|>'], ...tok.encode('check: does the answer fit?'), S['<|end|>'], S['<|ai|>']]);
    const p = 1 / (1 + Math.exp(l[tok.encode('no')[0]] - l[tok.encode('yes')[0]]));
    const ok = (p >= 0.5) === fits;
    right += ok;
    if (verbose) console.log(`${ok ? '✓' : '✗'} [checker] ${q} → ${a.slice(0, 50).replace(/\n/g, ' ')}… ${fits ? 'fits' : 'wrong'}, says ${(p * 100).toFixed(0)}% yes`);
  }
  console.log(`\ncode (trained tasks, new words)  ${seenOk}/${seen} correct, ${seenRun}/${seen} run`);
  console.log(`code (never-seen tasks)         ${freshOk}/${fresh} correct, ${freshRun}/${fresh} run`);
  console.log(`website                         ${siteProblem ? `invalid: ${siteProblem}` : 'valid HTML'}`);
  console.log(`checker                         ${right}/${CHECKS.length} right`);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exit(0);
}

main();
