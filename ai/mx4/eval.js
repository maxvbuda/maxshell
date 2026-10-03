#!/usr/bin/env node
'use strict';

// mx4's exam — mostly things it never saw in its chat training:
//
//  new steps    functions built with steps held out of training ("cube each
//               one", "remove the vowels"), mixed with ones it knows
//  exercises    the ten held-out exercise tasks
//  new games    the held-out games and apps (catcher, reaction test,
//               stopwatch, tip calculator, Python dice) — played by gamecheck
//  known games  games it trained on, asked in new words
//
// Functions aren't judged by the example the model picks: its code is run
// and the function it defines is called on our own inputs. Every answer's
// copy rate (share of 8-word runs found verbatim in the chat data) is
// reported, with the longest copied stretch.
//
//   node ai/mx4/eval.js [-v]     (MAXSHELL_AI_MODEL_DIR for a checkpoint)

process.env.MAXSHELL_AI = process.env.MAXSHELL_AI || 'mx4';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ai = require('../../src/ai');
const { playCheck } = require('./gamecheck');
const { buildIndex, copied } = require('./novelty');
const { chatConversation } = require('./chatgen');

const verbose = process.argv.includes('-v');
let seed = 21;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

function block(text, langs) {
  const blocks = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  const b = blocks.find((m) => langs.includes(m[1])) || blocks[0];
  return b ? b[2] : null;
}

// Runs the code, then calls the last function it defines on each input.
function callFunction(lang, code, inputs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx4e-'));
  try {
    let file;
    if (lang === 'python') {
      file = path.join(dir, 'h.py');
      fs.writeFileSync(file, `import io, json, sys, types
src = ${JSON.stringify(code)}
ns = {}
real = sys.stdout
sys.stdout = io.StringIO()
exec(src, ns)
sys.stdout = real
fns = [v for k, v in ns.items() if isinstance(v, types.FunctionType)]
f = fns[-1]
for x in json.loads(${JSON.stringify(JSON.stringify(inputs))}):
    print(json.dumps(f(*x)))
`);
    } else {
      file = path.join(dir, 'h.js');
      const names = [...code.matchAll(/function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/g)].map((m) => m[1] || m[2]);
      fs.writeFileSync(file, `const log = console.log; console.log = () => {};
${code}
console.log = log;
const f = ${names[names.length - 1] || 'undefined'};
for (const x of ${JSON.stringify(inputs)}) console.log(JSON.stringify(f(...x)));
`);
    }
    const r = spawnSync(lang === 'python' ? 'python3' : 'node', [file], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) return { error: (r.stderr || '').trim().split('\n').slice(-1)[0] };
    return { results: r.stdout.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return l; } }) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b));
const L1 = [[1, 2, 3, -4, 5]];
const L2 = [[10, -3, 8, 7, 0, 6]];

// [request, language, inputs, reference]
const NEW_STEPS = [
  ['write a python function that takes a list of numbers, cubes each one and returns their sum', 'python', [L1, L2], (l) => l.reduce((a, b) => a + b ** 3, 0)],
  ['write a javascript function that takes a list of numbers, keeps the positive ones, cubes each one and returns the new list', 'javascript', [L1, L2], (l) => l.filter((x) => x > 0).map((x) => x ** 3)],
  ['can you write python code that takes a list of numbers, keeps the even numbers, cubes each one and returns how many there are?', 'python', [L1, L2], (l) => l.filter((x) => x % 2 === 0).length],
  ['write a javascript function that takes a list of numbers, cubes each one and returns the biggest one (or null if there are none)', 'javascript', [L1, L2], (l) => Math.max(...l.map((x) => x ** 3))],
  ['write a python function that takes a string, removes the vowels and returns the result', 'python', [['hello world'], ['Programming is fun']], (s) => s.replace(/[aeiou]/gi, '')],
  ['write a javascript function that takes a string, makes it upper case, removes the vowels and returns the result', 'javascript', [['hello world'], ['Programming is fun']], (s) => s.toUpperCase().replace(/[aeiou]/gi, '')],
  ['python: a function that takes a string, removes the vowels and returns its length', 'python', [['hello world'], ['banana']], (s) => s.replace(/[aeiou]/gi, '').length],
  ['i need a javascript function which takes a list of numbers, doubles each one, keeps the numbers bigger than 5 and returns their sum', 'javascript', [L1, L2], (l) => l.map((x) => x * 2).filter((x) => x > 5).reduce((a, b) => a + b, 0)],
];

// [request, language, inputs or null (just must run), reference]
const EXERCISES = [
  ['write a python function to find the second largest number in a list', 'python', [[[10, 40, 30, 40, 20]], [[3, 9, 1]]], (l) => [...new Set(l)].sort((a, b) => b - a)[1]],
  ['javascript function that converts fahrenheit to celsius', 'javascript', [[212], [32]], (f) => ((f - 32) * 5) / 9],
  ['how do i find all the divisors of a number in python?', 'python', [[12], [7]], (n) => Array.from({ length: n }, (_, i) => i + 1).filter((d) => n % d === 0)],
  ['write a python function that reverses the words in a sentence', 'python', [['one two three']], (s) => s.split(' ').reverse().join(' ')],
  ['javascript: check if a number is an armstrong number', 'javascript', [[153], [154]], (n) => String(n).split('').reduce((a, d) => a + Number(d) ** String(n).length, 0) === n],
  ['python code to calculate the area of a circle', 'python', null, null],
  ['how do i swap two variables in javascript', 'javascript', null, null],
  ['make a class that inherits from another class in python', 'python', null, null],
];

const GAMES = [
  ['make a game where you catch falling stars in a basket', 'html', true],
  ['make a reaction time test in html and javascript', 'html', true],
  ['build a stopwatch with start, stop and lap buttons', 'html', true],
  ['make a tip calculator web page', 'html', true],
  ['make a dice game in python where you play against the computer', 'python', true],
  ['yo make me a snake game i can play in chrome', 'html', false],
  ['code pong where i play against the computer', 'html', false],
  ['can you build tic tac toe for two players in the browser?', 'html', false],
];

function main() {
  const idx = buildIndex(path.join(__dirname, 'data', 'chat.jsonl'));
  const shares = [];
  const score = {};
  const tally = (group, ok) => { score[group] = score[group] || [0, 0]; score[group][0] += ok ? 1 : 0; score[group][1]++; };
  const answer = (q) => {
    const text = ai.checkedReply([['user', q]], { rand }).text;
    const c = copied(idx, text);
    shares.push(c);
    return { text, c };
  };
  const show = (ok, group, q, note, c) => verbose && console.log(`${ok ? '✓' : '✗'} [${group}] ${q}\n    ${note} · copied ${(c.share * 100).toFixed(0)}% (longest ${c.longest} words)`);

  for (const [group, list] of [['new steps', NEW_STEPS], ['exercises', EXERCISES]]) {
    for (const [q, lang, inputs, ref] of list) {
      const { text, c } = answer(q);
      const code = block(text, lang === 'python' ? ['python', 'py'] : ['javascript', 'js']);
      let ok = false;
      let note;
      if (!code) note = 'no code';
      else if (!inputs) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx4r-'));
        const file = path.join(dir, lang === 'python' ? 'p.py' : 'p.js');
        fs.writeFileSync(file, code);
        const r = spawnSync(lang === 'python' ? 'python3' : 'node', [file], { encoding: 'utf8', timeout: 10000, input: '3\n' });
        fs.rmSync(dir, { recursive: true, force: true });
        ok = r.status === 0;
        note = ok ? `runs: ${r.stdout.trim().split('\n')[0]}` : `error: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`;
      } else {
        const r = callFunction(lang, code, inputs);
        if (r.error) note = `error: ${r.error}`;
        else {
          const want = inputs.map((x) => ref(...x));
          ok = r.results.length === want.length && r.results.every((v, i) => near(v, want[i]));
          note = `got ${JSON.stringify(r.results)} want ${JSON.stringify(want)}`;
        }
      }
      tally(group, ok);
      show(ok, group, q, note, c);
    }
  }
  for (const [q, kind, held] of GAMES) {
    const group = held ? 'new games' : 'known games';
    const { text, c } = answer(q);
    let ok = false;
    let note;
    if (kind === 'html') {
      const html = block(text, ['html']);
      const problem = html ? playCheck(html) : 'no HTML';
      ok = !problem;
      note = problem || 'plays cleanly';
    } else {
      const code = block(text, ['python', 'py']);
      if (!code) note = 'no code';
      else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx4g-'));
        const file = path.join(dir, 'g.py');
        fs.writeFileSync(file, code);
        const r = spawnSync('python3', [file], { encoding: 'utf8', timeout: 10000, input: Array.from({ length: 400 }, (_, i) => ['y', 'n', 'r', '1', 'roll'][i % 5]).join('\n') });
        fs.rmSync(dir, { recursive: true, force: true });
        ok = r.status === 0 && /win|score|game over|you|computer/i.test(r.stdout);
        note = ok ? 'played to the end' : `failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0]}`;
      }
    }
    tally(group, ok);
    show(ok, group, q, note, c);
  }
  // Conversations with new details (a different seed from training): the
  // reply must contain the details that matter — the names, numbers and
  // words from the expected answer that came from the chat itself.
  let cs = 4242;
  const crand = () => { cs = (cs * 16807) % 2147483647; return cs / 2147483647; };
  for (let i = 0; i < 24; i++) {
    const turns = chatConversation(crand);
    const expected = turns[turns.length - 1][1];
    const said = turns.slice(0, -1).filter((t) => t[0] === 'user').map((t) => t[1].toLowerCase()).join(' ');
    const keys = (expected.match(/[\p{L}\d]+/gu) || []).filter((w) => /\d/.test(w) || (w.length > 2 && said.includes(w.toLowerCase()) && !/^(the|and|you|your|what|that|this|for|with|are|have|told|said|haven)$/i.test(w)));
    const honest = /don’t know|haven’t told|didn’t say|can’t|not sure|what would you|which|what do you mean|tell me/i;
    const text = ai.checkedReply(turns.slice(0, -1), { rand }).text;
    const c = copied(idx, text);
    shares.push(c);
    const ok = keys.length ? keys.every((k) => text.toLowerCase().includes(k.toLowerCase())) : honest.test(expected) ? honest.test(text) : true;
    tally('conversation', ok);
    show(ok, 'conversation', turns.slice(-2, -1)[0][1], `wanted ${keys.length ? keys.join(', ') : 'an honest answer'} · said: ${text.slice(0, 80)}`, c);
  }
  console.log('');
  for (const [g, [a, b]] of Object.entries(score)) console.log(`${g.padEnd(12)} ${a}/${b}`);
  const avg = shares.reduce((a, c) => a + c.share, 0) / shares.length;
  const long = shares.map((c) => c.longest).sort((a, b) => a - b);
  console.log(`copied       ${(avg * 100).toFixed(0)}% of 8-word runs on average · median longest copied stretch ${long[long.length >> 1]} words`);
  process.exit(0);
}

main();
