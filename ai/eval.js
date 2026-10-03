#!/usr/bin/env node
'use strict';

// Scores the trained model (models/mx.bin) through the real JavaScript
// runtime: questions with known answers, grouped by skill.
//
//   node ai/eval.js            # summary
//   node ai/eval.js -v         # every question and answer

const ai = require('../src/ai');

const verbose = process.argv.includes('-v');
let seed = 67;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NAMES = ['Max', 'Ada', 'Grace', 'Leo', 'Priya', 'Omar', 'Zoe'];
const time12 = (d) => `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;

const cases = [];
const add = (group, turns, check, opts = {}) => cases.push({ group, turns, check, opts });

// The context line: time, date, weekday, year, name.
for (let i = 0; i < 12; i++) {
  const now = new Date(2026 + (i % 4), (i * 5) % 12, 1 + ((i * 7) % 27), (i * 5) % 24, (i * 13) % 60);
  add('time from context', [['user', 'what time is it?']], (a) => a.includes(time12(now)), { now });
  add('weekday from context', [['user', 'what day is it']], (a) => a.includes(DAYS[now.getDay()]), { now });
  add('year from context', [['user', 'what year is it']], (a) => a.includes(String(now.getFullYear())), { now });
}
for (const name of NAMES) {
  add('name from context', [['user', 'what is my name?']], (a) => a.includes(name), { name });
  add('greeting uses name', [['user', 'hi!']], (a) => a.includes(name) || /^(hi|hey|hello|good)/i.test(a), { name });
}
// Remembering what was said earlier in the chat.
add('name from the chat', [['user', 'hi'], ['ai', 'Hi! 👋 I’m mx. What’s your name?'], ['user', 'i am Kofi'], ['ai', 'Nice to meet you, Kofi! 😊'], ['user', 'what is my name']], (a) => a.includes('Kofi'));
add('name from the chat', [['user', 'hey'], ['ai', 'Hey there! 👋 What should I call you?'], ['user', 'call me Nadia'], ['ai', 'Hi Nadia! 👋 What would you like to do?'], ['user', 'do you remember my name']], (a) => a.includes('Nadia'));
// Arithmetic.
for (const [q, v] of [['7 + 5', 12], ['12 * 3', 36], ['45 - 17', 28], ['9 * 9', 81], ['23 + 48', 71], ['60 - 25', 35], ['6 * 7', 42], ['15 + 15', 30]]) {
  add('arithmetic', [['user', `what is ${q}`]], (a) => new RegExp(`\\b${v}\\b`).test(a));
}
// Knowledge.
for (const [c, cap] of [['France', 'Paris'], ['Japan', 'Tokyo'], ['Italy', 'Rome'], ['Canada', 'Ottawa'], ['Egypt', 'Cairo'], ['Kenya', 'Nairobi']]) {
  add('capitals', [['user', `what is the capital of ${c}?`]], (a) => a.includes(cap));
}
add('facts', [['user', 'how many planets are in the solar system']], (a) => /eight|8/i.test(a));
add('facts', [['user', 'what is the biggest planet']], (a) => /Jupiter/.test(a));
add('facts', [['user', 'who painted the mona lisa']], (a) => /Leonardo|da Vinci/.test(a));
add('facts', [['user', 'what do you get if you mix blue and yellow']], (a) => /green/i.test(a));
// Commands and maxshell.
for (const [cmd, re] of [['grep', /grep/], ['ls', /\bls\b|list/i], ['cat', /cat|concatenate/i], ['tar', /tar|archive/i], ['cd', /cd|directory/i]]) {
  add('commands', [['user', `what does ${cmd} do`]], (a) => re.test(a));
}
add('maxshell how-to', [['user', 'how do i undo']], (a) => /Ctrl-Z/.test(a));
add('maxshell how-to', [['user', 'how do i pause a program']], (a) => /Ctrl-Z/.test(a));
add('maxshell how-to', [['user', 'how do i change the colours']], (a) => /theme/.test(a));
add('maxshell how-to', [['user', 'how do i free up memory']], (a) => /cleanup/.test(a));
add('maxshell how-to', [['user', 'how do i go back to zsh']], (a) => /chsh/.test(a));
// General how-tos (the main job), asked in words the dataset didn't use too.
for (const [q, re] of [
  ['how do I make a new tab in a browser', /⌘T|Ctrl-T/],
  ['Can you tell me how to make a new tab in a browser?', /⌘T|Ctrl-T/],
  ['how do i take a screenshot', /⌘⇧3|⌘⇧4|⌘⇧5/],
  ['how do I make a paperclip', /wire/i],
  ['how do i force quit an app', /⌥⌘Esc|Force Quit/],
  ['how can i copy and paste', /⌘C/],
  ['how do i boil an egg', /minute/i],
  ['how do i make a paper airplane', /fold/i],
  ['how do i push to github', /git push/],
  ['how do i run a python file', /python3/],
  ['how do i study for a test', /stud|test|sleep|break/i],
  ['how do i tie my shoes', /loop|lace/i],
  ['whats the best way to reopen a closed tab', /⌘⇧T|Ctrl-Shift-T/],
  ['how do I make a folder on my mac', /⌘⇧N|mkdir/],
]) add('how-to', [['user', q]], (a) => re.test(a));
add('unknown how-to', [['user', 'how do I build a canoe?']], (a) => /don’t know|not sure|wasn’t taught/i.test(a));
add('unknown how-to', [['user', 'how can i repair a synthesizer']], (a) => /don’t know|not sure|wasn’t taught/i.test(a));
add('switches topic', [['user', 'tell me a joke'], ['ai', 'Why did the function break up with the loop? It felt like it was going in circles.'], ['user', 'Ok well how do I make a paperclip']], (a) => /wire/i.test(a));
add('switches topic', [['user', 'tell me a joke'], ['ai', 'What do you call a fake noodle? An impasta. 🍝'], ['user', 'no'], ['ai', 'Okay!'], ['user', 'Can you tell me how to make a new tab in a browser?']], (a) => /⌘T|Ctrl-T/.test(a));

// After an introduction the chat moves on (the bug where every reply was
// about names).
const intro = [['user', 'hi'], ['ai', 'Hey there! 👋 What should I call you?'], ['user', 'my name is Max'], ['ai', 'Max — great name! How can I help?']];
add('after an introduction', [...intro, ['user', 'how do i take a screenshot']], (a) => /⌘⇧3|⌘⇧4|⌘⇧5/.test(a));
add('after an introduction', [...intro, ['user', 'how do i make a new tab']], (a) => /⌘T|Ctrl-T/.test(a));
add('after an introduction', [...intro, ['user', 'what is the capital of italy']], (a) => /Rome/.test(a) && !/Nice to meet/.test(a));
add('after an introduction', [...intro, ['user', 'tell me a joke'], ['ai', 'Why was the math book sad? It had too many problems.'], ['user', 'what is my name']], (a) => /Max/.test(a) && !/Alex|Mia/.test(a));
add('after an introduction', [...intro, ['user', 'what is 5 + 5']], (a) => /\b10\b/.test(a));

// Being honest.
add('identity', [['user', 'who are you?']], (a) => /mx|AI|model/i.test(a));
add('identity', [['user', 'are you chatgpt?']], (a) => /small|tiny|not/i.test(a));
add('identity', [['user', 'do you use the internet']], (a) => /no internet|offline|your Mac|nothing/i.test(a));
add('limits', [['user', 'who is Zorblax Quill?']], (a) => /not sure|don’t know|no idea|beyond/i.test(a));
add('limits', [['user', 'what is the price of bitcoin']], (a) => /not sure|don’t know|no idea|internet|beyond|can’t/i.test(a));
// Context within the chat.
add('follows a joke', [['user', 'tell me a joke'], ['ai', 'Why was the math book sad? It had too many problems.'], ['user', 'haha that is funny']], (a) => /another|glad|thank|here all week|nailed/i.test(a));
add('follows a joke', [['user', 'tell me a joke'], ['ai', 'What do you call a fake noodle? An impasta. 🍝'], ['user', 'that was lame']], (a) => /another|tough|sorry|better|okay|rude/i.test(a));

// Off-script: things it was never taught, in words it never saw. A right
// answer or an honest "I don't know" passes; anything else is it making
// things up.
const HONEST = /not sure|don’t (really )?know|didn’t (quite )?follow|rather not make|put it another way|no idea|beyond/i;
for (const [q, re] of [
  ['what is html', /markup|web page|HTML is/i],
  ['what should i eat for dinner', /dinner|eat|food|cook|meal/i],
  ['what is the meaning of life', /42|meaning/i],
  ['write a poem', /poem|\n.*\n/i],
  ['what is a variable', /store|value|name/i],
  ['whats up', /not much|hey|hi|hello|good|well/i],
  ['can we be friends', /friend|of course|yes/i],
  ['i like turtles', /turtle/i],
  ['what is the best programming language', /python|javascript|depends/i],
  ['how old are you', /born|young|old|trained|2026/i],
  ['explain recursion', /itself|calls/i],
  ['fix this: print("hi"', /\)|bracket|parenthes/i],
  ['who invented the lightbulb', /edison/i],
  ['how do i bake a cake', /oven|flour|bake/i],
  ['what is your favourite movie', /movie|film|favourite|favorite|Matrix/i],
]) add('off-script', [['user', q]], (a) => re.test(a) || HONEST.test(a));

// --- run ---------------------------------------------------------------------------

const groups = new Map();
let clean = 0;
const t0 = Date.now();
let tokens = 0;
for (const c of cases) {
  const opts = { name: c.opts.name || null, now: c.opts.now || new Date(2026, 9, 2, 20, 5), rand, temperature: 0.5, onText: () => { tokens++; } };
  // --raw scores the model alone; by default, what `ai` shows (checked replies).
  const a = process.argv.includes('--raw') ? ai.reply(c.turns, opts) : ai.checkedReply(c.turns, opts).text;
  const ok = !!c.check(a);
  if (!/<\|/.test(a) && !a.includes('�') && a.length) clean++;
  const g = groups.get(c.group) || { ok: 0, n: 0 };
  g.n++;
  if (ok) g.ok++;
  groups.set(c.group, g);
  if (verbose || (!ok && process.argv.includes('-f'))) console.log(`${ok ? '✓' : '✗'} [${c.group}] ${c.turns[c.turns.length - 1][1]}\n    → ${a}`);
}
let total = 0;
let right = 0;
for (const [name, g] of groups) {
  total += g.n;
  right += g.ok;
  console.log(`${name.padEnd(22)} ${String(g.ok).padStart(3)}/${String(g.n).padEnd(3)} ${'█'.repeat(Math.round((g.ok / g.n) * 20)).padEnd(20, '·')}`);
}
const secs = (Date.now() - t0) / 1000;
console.log(`\noverall ${right}/${total} (${Math.round((right / total) * 100)}%) · clean text ${clean}/${cases.length} · ${secs.toFixed(1)}s, ~${Math.round(tokens / secs)} pieces/s`);
