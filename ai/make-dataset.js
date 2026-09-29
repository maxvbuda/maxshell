#!/usr/bin/env node
'use strict';

// Builds the chat dataset for maxshell's on-device model (`ai`), entirely on
// this Mac: no downloads. Sources:
//   - bot's rules, used as a teacher: thousands of phrasings of each request,
//     answered by src/bot.js (distillation), including multi-turn flows;
//   - the README (how maxshell works) and the Mac's own manual-page index
//     (`apropos`) for what commands do;
//   - hand-written small talk, feelings, identity, general knowledge,
//     arithmetic, and honest "I don't know" answers;
//   - a context line with the date, time and your name, so the model learns
//     to read facts it can't know from there.
//
// Output: ai/data/dataset.jsonl — one conversation per line:
//   {"sys": "...", "turns": [["user", "..."], ["ai", "..."], ...]}
//
//   node ai/make-dataset.js [--count N] [--seed S]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.env.MAXSHELL_BOT_FILE = '/dev/null';
const bot = require('../src/bot');
const D = require('../src/botdata');
const { Shell } = require('../src/interpreter');

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const TARGET = argOf('--count', 120000);
let seed = argOf('--seed', 67);

// --- deterministic randomness --------------------------------------------------

function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
Math.random = rand; // bot's own picks become reproducible too
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));

// --- making user messages look like real typing -------------------------------

function typo(word) {
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return word;
  const i = int(1, word.length - 2);
  const kind = int(0, 2);
  if (kind === 0) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  if (kind === 1) return word.slice(0, i) + word.slice(i + 1);
  return word.slice(0, i) + word[i] + word.slice(i);
}

// Casual variations: case, punctuation, fillers, contractions, the odd typo.
function vary(text) {
  let t = text;
  if (chance(0.25)) t = pick(['hey ', 'um ', 'so ', 'ok ', 'hmm ', 'yo ', 'hey, ', 'quick question: ']) + t;
  if (chance(0.15)) t += pick([' please', ' pls', ' thanks', ' lol', ' :)', ' 🙂']);
  if (chance(0.3)) t = t.replace(/[?.!]+$/, '');
  else if (chance(0.3) && !/[?.!]$/.test(t)) t += pick(['?', '!', '.', '??']);
  if (chance(0.5)) t = t.toLowerCase();
  else if (chance(0.5)) t = t.charAt(0).toUpperCase() + t.slice(1);
  if (chance(0.1)) t = t.split(' ').map((w) => (chance(0.3) ? typo(w) : w)).join(' ');
  if (chance(0.05)) t = t.toUpperCase();
  return t.replace(/\s+/g, ' ').trim();
}

// --- the context line ------------------------------------------------------------

const NAMES = ('Max Ada Grace Linus Sam Alex Jordan Taylor Riley Casey Morgan Jamie Avery Quinn Parker Emma Olivia Noah Liam '
  + 'Mia Leo Zoe Ella Lucas Chloe Ethan Aria Mason Lily Ben Nora Owen Ivy Finn Ruby Jack Maya Theo Luna Kai Iris Eli Hazel '
  + 'Omar Sara Priya Arjun Wei Mei Yuki Hana Diego Sofia Mateo Lucia Amir Leila Kofi Amara Ivan Nadia Lars Freya Jonas Ines').split(' ');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function randomContext() {
  const d = new Date(int(2024, 2030), int(0, 11), int(1, 28), int(0, 23), int(0, 59));
  return { now: d, name: chance(0.7) ? pick(NAMES) : null };
}

const fmtTime = (d) => `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
const fmtDate = (d) => `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
// The context line: date, time, name — and, when the message is a sum, the
// answer from maxshell's calculator (a tool the model learns to read).
const sysLine = (ctx) => `date: ${fmtDate(ctx.now)} · time: ${fmtTime(ctx.now)}${ctx.name ? ` · user: ${ctx.name}` : ''}${ctx.calc ? ` · calc: ${ctx.calc}` : ''}`;

// Using the name now and then, as a friendly assistant would.
function withName(text, ctx, p = 0.2) {
  if (!ctx.name || !chance(p) || !/^[A-Z][a-z’']/.test(text) || /^I[\s’']/.test(text)) return text;
  return `${ctx.name}, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

// --- collecting ------------------------------------------------------------------

const out = [];
// `dep`: the answers depend on the context line (the date, time or name),
// so this conversation can't be spliced into one with a different context.
function emit(ctx, turns, dep = false) {
  if (turns.some(([, t]) => !t || !t.trim())) return;
  const usesName = ctx.name && turns.some(([who, t]) => who === 'ai' && t.includes(ctx.name));
  out.push({ sys: sysLine(ctx), turns, dep: dep || !!usesName });
}

const shell = new Shell({ output: () => {}, error: () => {} });
shell.run(`cd ${ROOT}`);

// Asks bot (the rule engine) and keeps its answer, unless it's one that
// depends on this machine, the real clock, or is generated rambling.
const SKIP = new Set(['fallback', 'memory', 'cpu', 'battery', 'disk', 'macos', 'version', 'folder', 'git', 'time', 'date',
  'year', 'until', 'whatday', 'realai', 'whoareyou', 'maker', 'age', 'readme', 'explain', 'command', 'password', 'game',
  'trivia', 'riddle', 'rps', 'guess', 'dice', 'coin', 'number', 'eightball', 'choose', 'reverse', 'spell', 'count',
  'upper', 'lower', 'hello', 'bye', 'forget']);
function teacher(ctx, message, mem) {
  const m = mem || { name: ctx.name || undefined, nameRate: 0.2 };
  const reply = bot.reply(message, shell, m);
  if (!m.last || SKIP.has(m.last.name) || /💭|README|docs say/.test(reply)) return null;
  return reply;
}

// --- 1. distilling bot's skills --------------------------------------------------

const ASKS = {
  joke: ['tell me a joke', 'got any jokes', 'make me laugh', 'say something funny', 'i want a joke', 'joke please', 'know any good jokes', 'tell me a programming joke', 'cheer me up with a joke', 'a joke!'],
  fact: ['tell me a fun fact', 'give me a random fact', 'tell me something interesting', 'did you know anything cool', 'fun fact please', 'teach me something'],
  quote: ['inspire me', 'give me a quote', 'motivate me', 'i need some motivation', 'share an inspiring quote'],
  advice: ['any advice', 'give me a tip', 'what should i do, i am stuck', 'i need advice', 'help me focus'],
  compliment: ['compliment me', 'say something nice', 'make me feel better', 'cheer me up'],
  weather: ['what is the weather', 'is it going to rain', 'will it snow today', 'what is the forecast', 'is it sunny outside'],
  web: ['search google for cats', 'what is in the news', 'look up the news', 'check wikipedia for me'],
  thanks: ['thanks', 'thank you', 'thanks a lot', 'thank you so much', 'cheers', 'ty'],
  sorry: ['sorry', 'my bad', 'oops sorry'],
  howareyou: ['how are you', 'how is it going', 'how are you doing', 'how have you been', 'hows your day'],
  lovebot: ['you are awesome', 'i love you', 'you are the best', 'good bot', 'you are so smart'],
  meanbot: ['you are dumb', 'bad bot', 'you are useless', 'shut up'],
  friend: ['are you my friend', 'will you be my friend', 'do you like me'],
  favourite: ['what is your favorite color', 'what is your favourite food', 'what is your favorite number', 'what is your favorite movie', 'what is your favorite animal', 'what is your favorite language', 'what is your favorite shell', 'what is your favorite song', 'what is your favorite book', 'what is your favorite season'],
  opinion: ['what do you think about python', 'what do you think of javascript', 'what do you think about zsh', 'do you like cats', 'do you like dogs', 'thoughts on linux', 'what do you think about windows', 'what do you think of pizza', 'what do you think about school', 'what do you think of maxshell'],
  _topic: ['how do i undo', 'how do i pause a program', 'how do i free up memory', 'how do i change the theme', 'how do i search my history', 'how do i save a snippet', 'how do i bookmark a folder', 'how do i open the editor', 'how do i browse files', 'how do i commit with git', 'how do i see the dashboard', 'how do i make maxshell my default shell', 'how do i add aliases', 'how do i clear the screen', 'how do i jump to a folder', 'how do i open the palette', 'how do i leave maxshell'],
  feeling: ['i am sad', 'i feel tired', 'i am so bored', 'i am happy', 'i am stressed', 'i feel anxious', 'i am angry', 'i feel sick', 'i am hungry', 'i am confused', 'i am excited', 'i feel lonely', 'i am proud of myself'],
  percent: ['what is 15% of 80', 'what is 20 percent of 150', 'what is 50% of 64', 'what is 10% of 250', 'what is 25% of 40'],
  sqrt: ['square root of 144', 'what is the square root of 81', 'square root of 49', 'what is the square root of 225'],
  convert: ['convert 100 f to c', 'what is 5 miles in km', 'how many cm in 3 inches', '10 kg to pounds', '2 gb in mb', '30 c to f', '5 feet in meters', '2 hours in minutes', '3 liters to gallons', '100 km to miles'],
  wyr: ['would you rather fly or be invisible', 'would you rather have pizza or tacos'],
  love: ['what is love'],
  '67': ['6-7', 'six seven', '67'],
};

function distill() {
  for (let i = 0; i < 26000; i++) {
    const kind = pick(Object.keys(ASKS).filter((k) => !k.startsWith('_')));
    let q = pick(ASKS[kind]);
    if (kind === 'percent') q = `what is ${int(1, 99)}% of ${int(2, 500)}`;
    if (kind === 'sqrt') { const n = int(1, 30); q = `${pick(['what is the square root of', 'square root of', 'sqrt of'])} ${n * n}`; }
    const ctx = randomContext();
    const a = teacher(ctx, q);
    if (a) emit(ctx, [['user', vary(q)], ['ai', a]]);
  }
}

// --- 2. conversations that depend on context -----------------------------------------

function multiTurn() {
  const laughs = ['haha', 'lol', "that's funny", 'hahaha good one', 'lmao', 'that was hilarious', 'nice one 😂', 'ha!'];
  const boos = ['that was lame', 'not funny', 'bad joke', 'cringe', 'i do not get it'];
  const yeses = ['yes', 'sure', 'yeah', 'ok', 'another one', 'yes please', 'go on'];
  const nos = ['no thanks', 'nah', 'no', "i'm good"];
  for (let i = 0; i < 9000; i++) {
    const ctx = randomContext();
    const mem = { name: ctx.name || undefined, nameRate: 0.2 };
    const turns = [];
    const say = (u) => { const a = bot.reply(u, shell, mem); turns.push(['user', vary(u)], ['ai', a]); return a; };
    say(pick(ASKS.joke));
    const r = rand();
    if (r < 0.45) { say(pick(laughs)); say(chance(0.7) ? pick(yeses) : pick(nos)); if (chance(0.4)) say(pick(laughs)); } else if (r < 0.7) { say(pick(boos)); if (chance(0.7)) say(pick(yeses)); } else if (r < 0.85) { say(pick(['another', 'again', 'one more'])); } else { say('why?'); }
    emit(ctx, turns);
  }
  // Names told in the conversation, and remembered.
  for (let i = 0; i < 2500; i++) {
    const ctx = { now: randomContext().now, name: null };
    const name = pick(NAMES);
    const turns = [];
    const greet = pick(['hi', 'hello', 'hey', 'hey there', 'good morning', 'yo']);
    turns.push(['user', vary(greet)], ['ai', pick(['Hi! 👋 I’m mx. What’s your name?', 'Hey there! 👋 What should I call you?', 'Hello! I don’t think we’ve met — what’s your name?'])]);
    turns.push(['user', vary(pick([name, `i am ${name}`, `my name is ${name}`, `call me ${name}`, `it's ${name}`]))], ['ai', pick([`Nice to meet you, ${name}! 😊`, `Hi ${name}! 👋 What would you like to do?`, `${name} — great name! How can I help?`])]);
    const likes = pick(['pizza', 'cats', 'soccer', 'music', 'drawing', 'coding', 'chess', 'dogs', 'space', 'video games', 'reading', 'swimming', 'tacos', 'minecraft', 'the ocean']);
    if (chance(0.6)) turns.push(['user', vary(`i like ${likes}`)], ['ai', pick([`${likes.charAt(0).toUpperCase() + likes.slice(1)}? Nice taste! 😄`, `Noted: you like ${likes}. 😊`, `Ooh, ${likes} — good choice!`])]);
    if (chance(0.7)) turns.push(['user', vary(pick(['what is my name', 'do you remember my name', 'who am i']))], ['ai', pick([`You’re ${name}! 😊`, `Your name is ${name}.`, `You’re ${name} — how could I forget?`])]);
    if (turns.length > 4 && turns[4][1].startsWith('i like') && chance(0.8)) turns.push(['user', vary(pick(['what do i like', 'what do you know about me']))], ['ai', `You told me you like ${likes}${turns.some(([, t]) => /remember my name|what is my name|who am i/i.test(t)) ? '' : `, and your name is ${name}`}. 📝`]);
    emit(ctx, turns, true);
  }
  // Moods.
  for (let i = 0; i < 4000; i++) {
    const ctx = randomContext();
    const mem = { name: ctx.name || undefined, nameRate: 0.2 };
    const turns = [];
    const a1 = bot.reply('how are you', shell, mem);
    turns.push(['user', vary(pick(ASKS.howareyou))], ['ai', a1]);
    const mood = pick(['good', 'great', 'not bad', 'pretty good', 'tired', 'sad', 'stressed', 'bored', 'awesome', 'meh']);
    const a2 = bot.reply(mood, shell, mem);
    turns.push(['user', vary(pick([mood, `i am ${mood}`, `${mood} thanks`]))], ['ai', a2]);
    emit(ctx, turns);
  }
}

// --- 3. the clock and the context line -----------------------------------------------

function clock() {
  for (let i = 0; i < 22000; i++) {
    const ctx = randomContext();
    const d = ctx.now;
    const r = int(0, 5);
    let q; let a;
    if (r === 0) { q = pick(['what time is it', 'whats the time', 'time?', 'tell me the time', 'do you know what time it is', 'current time']); a = pick([`It’s ${fmtTime(d)}. ⏰`, `It’s ${fmtTime(d)} right now.`, `${fmtTime(d)}. ⏰`]); } else if (r === 1) { q = pick(['what is the date', 'whats todays date', 'what is today', 'date?', 'what day is it today']); a = pick([`Today is ${fmtDate(d)}. 📅`, `It’s ${fmtDate(d)}.`]); } else if (r === 2) { q = pick(['what day is it', 'what day of the week is it', 'which day is today']); a = `It’s ${DAYS[d.getDay()]}.`; } else if (r === 3) { q = pick(['what year is it', 'which year is it']); a = `It’s ${d.getFullYear()}.`; } else if (r === 4) {
      const hol = pick([['christmas', 12, 25], ['halloween', 10, 31], ['new year', 1, 1], ["valentine's day", 2, 14]]);
      const { days } = bot.daysUntil([hol[1], hol[2]], d);
      q = pick([`how many days until ${hol[0]}`, `days until ${hol[0]}`, `how long until ${hol[0]}`]);
      a = days === 0 ? `${hol[0].charAt(0).toUpperCase() + hol[0].slice(1)} is today! 🎉` : `${days} day${days === 1 ? '' : 's'} until ${hol[0].charAt(0).toUpperCase() + hol[0].slice(1)}. 📆`;
    } else {
      const h = d.getHours();
      q = pick(['good morning', 'good evening', 'good afternoon', 'hi', 'hello']);
      const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
      a = ctx.name ? pick([`Good ${part}, ${ctx.name}! 👋`, `Hey ${ctx.name}! 👋 How can I help?`, `Hi ${ctx.name}! What’s up?`]) : pick([`Good ${part}! 👋 How can I help?`, 'Hey there! 👋', `Hi! Good ${part}. 😊`]);
    }
    emit(ctx, [['user', vary(q)], ['ai', withName(a, ctx, 0.15)]], true);
  }
  // Names from the context line.
  for (let i = 0; i < 6000; i++) {
    const ctx = randomContext();
    const q = pick(['what is my name', 'who am i', 'do you know my name', 'whats my name']);
    const a = ctx.name ? pick([`You’re ${ctx.name}! 😊`, `Your name is ${ctx.name}.`]) : 'I don’t know yet! What’s your name?';
    emit(ctx, [['user', vary(q)], ['ai', a]], true);
  }
}

// --- 4. who it is --------------------------------------------------------------------

function identity() {
  const qs = {
    who: ['who are you', 'what are you', 'what is your name', 'introduce yourself', 'tell me about yourself'],
    real: ['are you real ai', 'are you chatgpt', 'are you gpt', 'are you a real ai', 'are you smart', 'are you sentient', 'are you alive', 'how do you work', 'are you claude'],
    where: ['where do you run', 'are you online', 'do you use the internet', 'do you send my data anywhere', 'are you private'],
    maker: ['who made you', 'who created you', 'who trained you', 'who built you'],
    size: ['how big are you', 'how many parameters do you have', 'how smart are you', 'how were you trained'],
  };
  const answers = {
    who: ['I’m mx, maxshell’s tiny AI. I run right here on your Mac. 🤖', 'I’m mx — a small language model built into maxshell. Ask me anything (I’ll do my best)!', 'mx! A little on-device AI that lives in your shell.'],
    real: ['I’m a real neural network — but a tiny one, about 15 million numbers, trained on this Mac. I make mistakes, so double-check anything important. 🤖', 'Sort of! I’m a small transformer model, like a very small GPT. I can chat, but I don’t know much about the world.', 'I’m a tiny language model, not ChatGPT or Claude. Much smaller, and I run entirely on your Mac.'],
    where: ['I run completely on your Mac — no internet, and nothing you type leaves this computer. 🔒', 'Offline, right here in maxshell. I can’t browse the web or send anything anywhere.'],
    maker: ['Max built maxshell, and I was trained for it on Max’s Mac, from a dataset made just for me. 🛠️', 'I was made for maxshell by Max — trained on this very computer.'],
    size: ['I’m tiny: about 15 million parameters, trained on this Mac’s GPU in about an hour. GPT-2 small has 124 million!', 'Small enough to run on your laptop. I was trained on a dataset of made-up chats, maxshell’s docs and your Mac’s manual pages.'],
  };
  for (let i = 0; i < 4500; i++) {
    const k = pick(Object.keys(qs));
    const ctx = randomContext();
    emit(ctx, [['user', vary(pick(qs[k]))], ['ai', pick(answers[k])]]);
  }
}

// --- 5. maxshell, from the README ------------------------------------------------------

function readme() {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const sections = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h) { cur = { title: h[1].replace(/[`*]/g, '').trim(), lines: [] }; sections.push(cur); } else if (cur) cur.lines.push(line);
  }
  for (const s of sections) {
    const prose = s.lines.join('\n').replace(/```[\s\S]*?```/g, '\n').split('\n')
      .filter((l) => l.trim() && !/^\s*(\||    |-{3,})/.test(l)).join(' ')
      .replace(/\*\*|__/g, '').replace(/(^|\s)\*([^*]+)\*/g, '$1$2').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ').trim();
    s.sentences = prose.split(/(?<=[.!?])\s+(?=[A-Z`"“])/).filter((x) => x.length > 20 && x.length < 320);
  }
  const good = sections.filter((s) => s.sentences.length && !/^(License|Project layout)$/.test(s.title));
  for (let i = 0; i < 9000; i++) {
    const s = pick(good);
    const topic = s.title.replace(/ — .*$/, '').replace(/^(The|A) /, '').toLowerCase();
    const q = pick([`how does ${topic} work`, `tell me about ${topic}`, `what is ${topic} in maxshell`, `explain ${topic}`, `how do i use ${topic}`, `what does maxshell do with ${topic}`, `${topic}?`]);
    const n = Math.min(s.sentences.length, int(1, 3));
    const start = int(0, Math.max(0, s.sentences.length - n));
    const body = s.sentences.slice(start, start + n).join(' ');
    const lead = pick(['', '', `${s.title.replace(/ — .*$/, '')}: `, 'In maxshell, ', 'Sure! ']);
    emit(randomContext(), [['user', vary(q)], ['ai', lead && lead !== 'In maxshell, ' ? lead + body : body]]);
  }
}

// --- 5b. how to do things (the main job) ---------------------------------------------

const HOWTO = require('./howto-data');

const HOW_ASK = [
  (t) => `how do i ${t}`, (t) => `how do i ${t}?`, (t) => `how can i ${t}`, (t) => `how to ${t}`,
  (t) => `can you tell me how to ${t}`, (t) => `can you tell me how to ${t}?`, (t) => `tell me how to ${t}`,
  (t) => `what's the way to ${t}`, (t) => `i want to ${t}`, (t) => `i need to ${t}`, (t) => `help me ${t}`,
  (t) => `steps to ${t}`, (t) => `explain how to ${t}`, (t) => `what is the best way to ${t}`,
  (t) => `how would i ${t}`, (t) => `how do you ${t}`, (t) => `could you show me how to ${t}`,
  (t) => `ok well how do i ${t}`, (t) => `and how do i ${t}`, (t) => `so how can i ${t}`,
];

function howAnswer(answer) {
  return pick(['', '', '', 'Sure! ', 'Here’s how: ', 'Good question! ']) + answer;
}

function howto() {
  for (let i = 0; i < 40000; i++) {
    const [tasks, answer] = pick(HOWTO);
    const q = pick(HOW_ASK)(pick(tasks));
    const ctx = randomContext();
    emit(ctx, [['user', vary(q)], ['ai', howAnswer(answer)]]);
  }
  // Things it wasn't taught: say so, instead of making up steps.
  const VERBS = ['build', 'fix', 'paint', 'repair', 'install', 'clean', 'knit', 'sew', 'program', 'tune', 'grow', 'train', 'carve', 'design', 'weld', 'brew', 'forge', 'assemble', 'calibrate', 'restore'];
  const THINGS = ['a canoe', 'a violin', 'a car engine', 'a greenhouse', 'a drone', 'a robot arm', 'a quilt', 'a telescope', 'a guitar amp', 'a birdhouse', 'a sourdough starter', 'a satellite dish', 'a rocking chair', 'a pinball machine', 'a hot air balloon', 'a water filter', 'a chandelier', 'a kayak', 'a treehouse', 'a synthesizer', 'a ceramic vase', 'a bonsai tree', 'a stained glass window', 'a leather wallet', 'a compost bin'];
  for (let i = 0; i < 9000; i++) {
    const task = `${pick(VERBS)} ${pick(THINGS)}`;
    const q = pick(HOW_ASK)(task);
    const a = pick([
      `I don’t know how to ${task} — I’m a small model and wasn’t taught that one. A search for “how to ${task}” should find good guides.`,
      `Sorry, I don’t know the steps to ${task}. I only know a few hundred how-tos — try looking up “how to ${task}”.`,
      `I’m not sure how to ${task}, and I’d rather not guess. A video guide would be a good place to start.`,
    ]);
    emit(randomContext(), [['user', vary(q)], ['ai', a]]);
  }
}

// Standalone questions with known answers (no context needed), to mix into
// longer conversations.
function standaloneQA() {
  const [tasks, answer] = pick(HOWTO);
  const r = rand();
  if (r < 0.45) return [vary(pick(HOW_ASK)(pick(tasks))), howAnswer(answer)];
  if (r < 0.6) { const [q, a] = pick(QA); return [vary(q), a]; }
  if (r < 0.7) { const [c, cap] = pick(CAPITALS); return [vary(`what is the capital of ${c}`), `The capital of ${c} is ${cap}${/\.$/.test(cap) ? '' : '.'}`]; }
  if (r < 0.8) { const q = pick(ASKS.joke); return [vary(q), bot.reply('tell me a joke', shell, {})]; }
  if (r < 0.9) { const q = pick(ASKS.fact); return [vary(q), bot.reply('tell me a fun fact', shell, {})]; }
  return [vary(pick(['thanks', 'cool', 'ok thanks', 'nice'])), pick(['You’re welcome! 😊', 'Any time!', '👍 Anything else?'])];
}

// After you introduce yourself, the chat moves on: real questions get real
// answers; the name is used now and then, and recalled when asked.
function introductions() {
  for (let i = 0; i < 14000; i++) {
    const ctx = { now: randomContext().now, name: null };
    const name = pick(NAMES);
    const turns = [];
    turns.push(['user', vary(pick(['hi', 'hello', 'hey', 'hey there', 'yo', 'hi!']))], ['ai', pick(['Hi! 👋 I’m mx. What’s your name?', 'Hey there! 👋 What should I call you?', 'Hello! What’s your name?'])]);
    turns.push(['user', vary(pick([name, `i am ${name}`, `my name is ${name}`, `call me ${name}`, `it's ${name}`]))], ['ai', pick([`Nice to meet you, ${name}! 😊 What can I help with?`, `Hi ${name}! 👋 What would you like to do?`, `${name} — great name! How can I help?`])]);
    const n = int(1, 4);
    for (let k = 0; k < n; k++) {
      let [q, a] = standaloneQA();
      if (chance(0.12) && /^[A-Z][a-z]/.test(a) && !/^I[\s’']/.test(a)) a = `${name}, ${a.charAt(0).toLowerCase()}${a.slice(1)}`;
      turns.push(['user', q], ['ai', a]);
    }
    if (chance(0.35)) turns.push(['user', vary(pick(['what is my name', 'do you remember my name', 'who am i']))], ['ai', pick([`You’re ${name}! 😊`, `Your name is ${name}.`])]);
    emit(ctx, turns, true);
  }
}

// Several unrelated questions in a row: each is its own thing.
function longChats() {
  for (let i = 0; i < 14000; i++) {
    const ctx = randomContext();
    const turns = [];
    const n = int(3, 6);
    for (let k = 0; k < n; k++) { const [q, a] = standaloneQA(); turns.push(['user', q], ['ai', a]); }
    emit(ctx, turns);
  }
}

// Changing the subject: a new question after a joke (or anything) gets a
// real answer, not a reaction to the joke.
function topicSwitch() {
  for (let i = 0; i < 12000; i++) {
    const ctx = randomContext();
    const mem = { name: ctx.name || undefined, nameRate: 0 };
    const turns = [];
    const opener = rand();
    if (opener < 0.5) {
      turns.push(['user', vary(pick(ASKS.joke))], ['ai', bot.reply('tell me a joke', shell, mem)]);
      if (chance(0.4)) turns.push(['user', vary(pick(['haha', 'lol', 'ok', 'nice']))], ['ai', pick(['Glad you liked it! 😄 Want another one?', 'Haha 😄', 'Thanks! 😄'])]);
    } else if (opener < 0.7) {
      turns.push(['user', vary(pick(ASKS.fact))], ['ai', bot.reply('tell me a fun fact', shell, mem)]);
    } else {
      turns.push(['user', vary(pick(['hi', 'hey', 'how are you', 'hello there']))], ['ai', pick(['Hey! 👋 What can I help with?', 'Hi! What’s up?', 'Doing great, thanks! What can I do for you?'])]);
    }
    const [tasks, answer] = pick(HOWTO);
    turns.push(['user', vary(pick(HOW_ASK)(pick(tasks)))], ['ai', howAnswer(answer)]);
    if (chance(0.4)) {
      const [tasks2, answer2] = pick(HOWTO);
      turns.push(['user', vary(pick(HOW_ASK)(pick(tasks2)))], ['ai', howAnswer(answer2)]);
    }
    if (chance(0.3)) turns.push(['user', vary(pick(['thanks', 'thank you', 'cool thanks', 'got it']))], ['ai', pick(['You’re welcome! 😊', 'Any time!', 'Happy to help!'])]);
    emit(ctx, turns);
  }
}

// --- 6. commands, from the Mac's manual index --------------------------------------------

function commands() {
  const r = spawnSync('apropos', ['.'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const descs = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^([^()]+)\((1|8)\)\s+-\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const desc = m[3].trim().replace(/\s+/g, ' ');
    if (desc.length < 8 || desc.length > 110) continue;
    for (const name of m[1].split(',').map((x) => x.trim())) {
      if (/^[a-z][\w.+-]*$/.test(name) && !descs.has(name)) descs.set(name, desc);
    }
  }
  const { COMMAND_DESC, BUILTIN_DESC } = require('../src/complete');
  for (const [k, v] of Object.entries(COMMAND_DESC)) descs.set(k, v);
  const names = [...descs.keys()];
  for (let i = 0; i < 18000; i++) {
    const name = pick(names);
    const desc = descs.get(name).replace(/\.$/, '');
    const lower = desc.charAt(0).toLowerCase() + desc.slice(1);
    const q = pick([`what does ${name} do`, `what is ${name}`, `what is the ${name} command`, `explain ${name}`, `${name}?`, `what's ${name} for`]);
    const a = pick([`\`${name}\` — ${lower}.`, `\`${name}\` is a command that does this: ${lower}.`, `It’s a command on your Mac: ${lower}. Try \`man ${name}\` for the details.`, `\`${name}\`: ${lower}.`]);
    emit(randomContext(), [['user', vary(q)], ['ai', a]]);
  }
  for (let i = 0; i < 2500; i++) {
    const [name, desc] = pick(Object.entries(BUILTIN_DESC));
    emit(randomContext(), [['user', vary(pick([`what does ${name} do`, `what is ${name}`, `${name}?`]))], ['ai', `\`${name}\` is built into maxshell: ${desc}.`]]);
  }
}

// --- 7. general knowledge (hand-written) --------------------------------------------------

const CAPITALS = [['France', 'Paris'], ['Germany', 'Berlin'], ['Italy', 'Rome'], ['Spain', 'Madrid'], ['Japan', 'Tokyo'], ['China', 'Beijing'], ['India', 'New Delhi'], ['Canada', 'Ottawa'], ['Mexico', 'Mexico City'], ['Brazil', 'Brasília'], ['Argentina', 'Buenos Aires'], ['Australia', 'Canberra'], ['the United States', 'Washington, D.C.'], ['the United Kingdom', 'London'], ['Russia', 'Moscow'], ['Egypt', 'Cairo'], ['Kenya', 'Nairobi'], ['Nigeria', 'Abuja'], ['South Africa', 'Pretoria'], ['Sweden', 'Stockholm'], ['Norway', 'Oslo'], ['Denmark', 'Copenhagen'], ['Finland', 'Helsinki'], ['Poland', 'Warsaw'], ['Greece', 'Athens'], ['Turkey', 'Ankara'], ['Portugal', 'Lisbon'], ['Ireland', 'Dublin'], ['the Netherlands', 'Amsterdam'], ['Belgium', 'Brussels'], ['Switzerland', 'Bern'], ['Austria', 'Vienna'], ['South Korea', 'Seoul'], ['Thailand', 'Bangkok'], ['Vietnam', 'Hanoi'], ['Indonesia', 'Jakarta'], ['the Philippines', 'Manila'], ['New Zealand', 'Wellington'], ['Chile', 'Santiago'], ['Peru', 'Lima'], ['Colombia', 'Bogotá'], ['Cuba', 'Havana'], ['Israel', 'Jerusalem'], ['Iran', 'Tehran'], ['Saudi Arabia', 'Riyadh'], ['Pakistan', 'Islamabad'], ['Ukraine', 'Kyiv'], ['Czechia', 'Prague'], ['Hungary', 'Budapest'], ['Iceland', 'Reykjavík']];

const QA = [
  ['how many planets are in the solar system', 'There are eight planets: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus and Neptune. 🪐'],
  ['what is the biggest planet', 'Jupiter is the biggest planet in our solar system.'],
  ['what is the closest star', 'The Sun! After that, it’s Proxima Centauri, about 4.2 light-years away.'],
  ['why is the sky blue', 'Sunlight scatters off the air, and blue light scatters the most — so the sky looks blue. ☀️'],
  ['what is gravity', 'Gravity is the pull between things with mass. It keeps us on the ground and the Moon around the Earth.'],
  ['what is photosynthesis', 'It’s how plants turn sunlight, water and carbon dioxide into sugar and oxygen. 🌱'],
  ['what is water made of', 'Water is H₂O: two hydrogen atoms and one oxygen atom.'],
  ['how hot is the sun', 'The surface of the Sun is about 5,500 °C, and the core is millions of degrees.'],
  ['what is the speed of light', 'About 300,000 km per second.'],
  ['how far is the moon', 'The Moon is about 384,000 km away from Earth. 🌙'],
  ['what is the largest ocean', 'The Pacific Ocean.'],
  ['what is the tallest mountain', 'Mount Everest, at about 8,849 metres. 🏔️'],
  ['what is the longest river', 'The Nile and the Amazon are the two longest — around 6,500–7,000 km each.'],
  ['how many continents are there', 'Seven: Africa, Antarctica, Asia, Australia, Europe, North America and South America.'],
  ['what is dna', 'DNA is the molecule that carries the instructions for building and running living things. 🧬'],
  ['what is an atom', 'An atom is the tiny building block of everything — a nucleus with electrons around it.'],
  ['what is a computer', 'A machine that follows instructions (programs) very quickly to process information. 💻'],
  ['what is a cpu', 'The CPU is the computer’s brain: it runs the instructions of every program.'],
  ['what is ram', 'RAM is a computer’s short-term memory — fast, and cleared when the power goes off.'],
  ['what is the internet', 'A worldwide network of computers that can send data to each other.'],
  ['what is a program', 'A list of instructions for a computer to follow.'],
  ['what is programming', 'Writing instructions for a computer, in a language like Python or JavaScript.'],
  ['what is python', 'Python is a popular, friendly programming language. 🐍'],
  ['what is javascript', 'JavaScript is the language of the web — and the language maxshell is written in.'],
  ['what is a shell', 'A shell is a program that reads commands you type and runs them. maxshell is one!'],
  ['what is linux', 'Linux is a free operating system that runs most of the world’s servers. 🐧'],
  ['what is an operating system', 'The software that runs your computer and lets other programs work — like macOS, Windows or Linux.'],
  ['what is ai', 'AI is software that learns patterns from data to do things like chat, see or play games. I’m a very small example!'],
  ['what is a neural network', 'A program made of many small numbers (weights) that it adjusts while learning from examples. I’m one — a tiny one.'],
  ['what is machine learning', 'Teaching computers from examples instead of writing every rule by hand.'],
  ['what is an algorithm', 'A step-by-step recipe for solving a problem.'],
  ['what is a bug', 'A mistake in a program that makes it behave wrongly. 🐛'],
  ['what is git', 'Git keeps the history of your code, so you can save versions and work with others.'],
  ['what is a file', 'A named piece of data stored on your computer, like a photo, a document or a program.'],
  ['what is a folder', 'A container for files (and other folders), to keep things organised.'],
  ['how many days in a year', '365 — or 366 in a leap year.'],
  ['how many hours in a day', '24 hours.'],
  ['how many minutes in an hour', '60 minutes.'],
  ['how many seconds in a minute', '60 seconds.'],
  ['how many days in a week', 'Seven days.'],
  ['how many weeks in a year', '52 weeks, plus a day or two.'],
  ['what are the primary colors', 'Red, yellow and blue for paint; red, green and blue for light. 🎨'],
  ['what do you get if you mix blue and yellow', 'Green!'],
  ['what do you get if you mix red and blue', 'Purple!'],
  ['what do you get if you mix red and yellow', 'Orange!'],
  ['what is the fastest animal', 'The peregrine falcon when diving; on land, the cheetah. 🐆'],
  ['what is the biggest animal', 'The blue whale — the biggest animal that has ever lived. 🐋'],
  ['how many legs does a spider have', 'Eight. 🕷️'],
  ['how many legs does an insect have', 'Six.'],
  ['do fish sleep', 'Yes — they rest, though most don’t close their eyes.'],
  ['why do cats purr', 'Mostly when they’re content, but sometimes to calm themselves too. 🐈'],
  ['what do pandas eat', 'Almost only bamboo. 🐼'],
  ['how long do dogs live', 'Usually around 10 to 15 years, depending on the breed. 🐕'],
  ['who invented the telephone', 'Alexander Graham Bell is usually credited, in 1876.'],
  ['who invented the light bulb', 'Many people worked on it; Thomas Edison made the first practical one around 1879.'],
  ['who was the first person on the moon', 'Neil Armstrong, in 1969. 🌙'],
  ['who painted the mona lisa', 'Leonardo da Vinci.'],
  ['who wrote romeo and juliet', 'William Shakespeare.'],
  ['who discovered gravity', 'Isaac Newton described it in the 1680s — the famous apple story.'],
  ['who made the first computer', 'Charles Babbage designed one in the 1800s; the first electronic computers came in the 1940s.'],
  ['what is the boiling point of water', '100 °C (212 °F) at sea level.'],
  ['what is the freezing point of water', '0 °C (32 °F).'],
  ['what is the largest country', 'Russia, by area.'],
  ['what is the smallest country', 'Vatican City.'],
  ['what language do they speak in brazil', 'Portuguese.'],
  ['what language do they speak in mexico', 'Spanish.'],
  ['how do airplanes fly', 'Their wings are shaped so air pushes them up (lift) as they move forward fast. ✈️'],
  ['how do rainbows form', 'Sunlight bends and splits into colours inside raindrops. 🌈'],
  ['why do we sleep', 'Sleep lets your body and brain rest, repair and store memories. 😴'],
  ['why do leaves change color', 'In autumn trees stop making green chlorophyll, so the yellow and red colours show. 🍂'],
  ['what is the moon made of', 'Rock and dust — not cheese, sadly. 🧀'],
  ['is pluto a planet', 'Since 2006 it’s called a dwarf planet.'],
  ['what is a black hole', 'A place where gravity is so strong that not even light can escape. 🕳️'],
  ['how old is the earth', 'About 4.5 billion years.'],
  ['how old is the universe', 'About 13.8 billion years.'],
];

function knowledge() {
  for (let i = 0; i < 5000; i++) {
    const [country, capital] = pick(CAPITALS);
    const q = pick([`what is the capital of ${country}`, `capital of ${country}`, `whats ${country}'s capital`, `what city is the capital of ${country}`]);
    const end = /\.$/.test(capital) ? '' : '.';
    emit(randomContext(), [['user', vary(q)], ['ai', pick([`The capital of ${country} is ${capital}${end}`, `${capital}${end}`, `It’s ${capital}!`])]]);
  }
  for (let i = 0; i < 9000; i++) {
    const [q, a] = pick(QA);
    emit(randomContext(), [['user', vary(pick([q, q, `do you know ${q}`, `can you tell me ${q}`, `${q}?`]))], ['ai', a]]);
  }
}

// --- 8. honest about limits ----------------------------------------------------------------

function limits() {
  const FIRST = ['Zorblax', 'Quentin', 'Marlowe', 'Tavish', 'Elowen', 'Brakka', 'Silvio', 'Octavia', 'Grummel', 'Pell'];
  const LAST = ['Vantree', 'Oakhurst', 'Quill', 'Marchetti', 'Fenwright', 'Blume', 'Ostrander', 'Kettleby'];
  const PLACES = ['Frostvale', 'Lumeria', 'Port Ashby', 'New Brellin', 'Kovasta', 'Upper Marsh'];
  const unknown = [
    () => `who is ${pick(FIRST)} ${pick(LAST)}`, () => `what is the population of ${pick(PLACES)}`,
    () => `when was ${pick(PLACES)} founded`, () => `what happened in the news today`, () => `what is the price of bitcoin`,
    () => `who won the game last night`, () => `what is the stock price of apple`, () => `what is the weather in ${pick(PLACES)}`,
    () => `what is the latest iphone`, () => `who is the president right now`,
  ];
  const answers = ['I don’t know that one — I’m a small model trained on this Mac, and I don’t know much about the wider world. 🤷', 'I’m not sure. I can’t look things up (no internet), so I’d only be guessing.', 'No idea, honestly! I’m tiny and offline — try a search engine for that one.', 'That’s beyond what I learned. I don’t have internet access, so I can’t check.'];
  for (let i = 0; i < 5000; i++) emit(randomContext(), [['user', vary(pick(unknown)())], ['ai', pick(answers)]]);
}

// --- 9. arithmetic ---------------------------------------------------------------------------

function arithmetic() {
  for (let i = 0; i < 16000; i++) {
    const op = pick(['+', '-', '*', '+', '-']);
    const a = op === '*' ? int(0, 12) : int(0, 99);
    const b = op === '*' ? int(0, 12) : int(0, 99);
    const v = op === '+' ? a + b : op === '-' ? a - b : a * b;
    const word = { '+': pick(['+', 'plus']), '-': pick(['-', 'minus']), '*': pick(['*', 'times', 'x']) }[op];
    const q = pick([`what is ${a} ${word} ${b}`, `${a} ${word} ${b}`, `${a}${op}${b}`, `calculate ${a} ${word} ${b}`, `what's ${a} ${word} ${b}?`]);
    const ctx = randomContext();
    const sym = op === '*' ? '×' : op;
    ctx.calc = `${a} ${sym} ${b} = ${v}`;
    emit(ctx, [['user', vary(q)], ['ai', pick([`${a} ${sym} ${b} = ${v}.`, `That’s ${v}. 🧮`, `${v}.`, `It’s ${v}.`])]], true);
  }
}

// --- 10. general chat, from bot's corpus ------------------------------------------------------

function chat() {
  const corpus = fs.readFileSync(path.join(ROOT, 'src', 'botcorpus.txt'), 'utf8').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const paragraphs = corpus.map((p) => ({ sents: p.split(/(?<=[.!?])\s+/), key: (p.match(/^(\w+)/) || [])[1].toLowerCase() }));
  const TOPIC_WORDS = { computers: ['computers', 'programming', 'coding'], the: ['the terminal', 'the command line'], music: ['music', 'songs'], food: ['food', 'cooking', 'pizza'], animals: ['animals', 'pets', 'dogs', 'cats'], space: ['space', 'planets', 'the stars'], nature: ['nature', 'trees', 'the seasons'], school: ['school', 'homework', 'learning'], friends: ['friends', 'friendship'], games: ['games', 'video games', 'chess'], sports: ['sports', 'soccer', 'basketball'], travel: ['travel', 'trips'], feelings: ['feelings', 'emotions'], hobbies: ['hobbies', 'drawing', 'gardening'], time: ['time', 'mornings', 'weekends'], robots: ['robots', 'chatbots'], ideas: ['ideas', 'curiosity'], kindness: ['kindness', 'being kind'], books: ['books', 'reading'], movies: ['movies', 'films'], inventions: ['inventions', 'the internet'], mistakes: ['mistakes', 'failure'] };
  for (let i = 0; i < 9000; i++) {
    const p = pick(paragraphs);
    const topic = pick(TOPIC_WORDS[p.key] || [p.key]);
    const q = pick([`tell me about ${topic}`, `what do you think about ${topic}`, `do you like ${topic}`, `talk to me about ${topic}`, `say something about ${topic}`, `i like ${topic}`, `${topic}!`]);
    const n = int(1, 3);
    const start = int(0, Math.max(0, p.sents.length - n));
    const lead = /^do you like/.test(q) ? pick(['I do! ', 'Yes! ', 'I really like it. ']) : /^i like/.test(q) ? pick(['Me too! ', 'Nice! ', 'Same here. ']) : '';
    emit(randomContext(), [['user', vary(q)], ['ai', lead + p.sents.slice(start, start + n).join(' ')]]);
  }
  // Small talk.
  const SMALL = [
    [['what are you doing', 'what are you up to', 'whatcha doing'], ['Just hanging out in your terminal, waiting for a question. 😄', 'Thinking about tokens. You know, the usual.', 'Chatting with you!']],
    [['do you sleep', 'do you get tired', 'do you dream'], ['Not really — I only wake up when you type `ai`. 😴', 'Nope! Though I do rest between messages.']],
    [['do you have feelings', 'are you happy', 'can you feel'], ['Not like you do — I predict words. But this conversation is nice! 😊', 'I don’t really feel things, but I’m designed to be friendly.']],
    [['what is your favorite food', 'do you eat'], ['I don’t eat, but if I could I’d try pizza. 🍕', 'Electricity, mostly. ⚡']],
    [['can you help me', 'i need help', 'help me'], ['Of course! What do you need?', 'Sure — tell me what’s up.', 'I’ll try! What is it?']],
    [['tell me a story', 'tell me a short story'], ['Once upon a time, a tiny AI lived in a terminal. Every day it answered questions, and every night it dreamed of bigger GPUs. The end. 📖', 'A curious cat found a keyboard, typed `ls`, and discovered a whole world of folders. It never came back. 🐈']],
    [['you are funny', 'you are cute', 'you are cool'], ['Thank you! 😊', 'Aww, thanks!', 'You’re pretty cool yourself. 😎']],
    [['good night', 'going to bed', 'night'], ['Good night! Sleep well. 😴', 'Night! See you tomorrow. 🌙']],
    [['i am back', 'im back', 'hello again'], ['Welcome back! 👋', 'Hey, you’re back! What’s next?']],
    [['ok', 'okay', 'cool', 'nice', 'got it'], ['👍', 'Anything else?', 'Cool!', 'Great! What’s next?']],
    [['bye', 'goodbye', 'see you', 'cya'], ['Bye! 👋', 'See you later!', 'Take care! 😊']],
    [['yes', 'yeah'], ['Great!', 'Awesome — what next?']],
    [['no', 'nope'], ['Okay!', 'No problem.']],
    [['what can you do', 'help me out', 'what do you know'], ['I can chat, answer questions about maxshell and your Mac’s commands, tell the time, do simple maths, and share facts and jokes. I’m small, so I make mistakes!', 'Ask me how maxshell works, what a command does, simple maths, the time, or just chat!']],
  ];
  for (let i = 0; i < 6000; i++) {
    const [qs, as] = pick(SMALL);
    const ctx = randomContext();
    emit(ctx, [['user', vary(pick(qs))], ['ai', withName(pick(as), ctx)]]);
  }
}

// --- 11. longer mixed conversations -------------------------------------------------------

function mixed(n) {
  const base = out.filter((c) => !c.dep);
  for (let i = 0; i < n; i++) {
    const parts = [pick(base), pick(base), pick(base)].slice(0, int(2, 3));
    const ctx = randomContext();
    const turns = parts.flatMap((c) => c.turns.filter((_, k, arr) => k < arr.length).map((t) => t))
      .filter(([, t]) => !/your name is|You’re [A-Z]|You told me/.test(t));
    if (turns.length && turns.length % 2 === 0) out.push({ sys: sysLine(ctx), turns, dep: false });
  }
}

// --- go ---------------------------------------------------------------------------------------

const steps = [['distilling bot', distill], ['multi-turn', multiTurn], ['clock and context', clock], ['identity', identity], ['README', readme], ['how-to', howto], ['topic switches', topicSwitch], ['introductions', introductions], ['commands', commands], ['general knowledge', knowledge], ['long chats', longChats], ['limits', limits], ['arithmetic', arithmetic], ['chat', chat]];
for (const [label, fn] of steps) {
  const before = out.length;
  fn();
  process.stderr.write(`  ${label.padEnd(20)} ${out.length - before}\n`);
}
mixed(Math.max(0, Math.floor((TARGET - out.length) * 0.5)));
// Shuffle.
for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }

const dir = path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'dataset.jsonl');
fs.writeFileSync(file, `${out.map(({ sys, turns }) => JSON.stringify({ sys, turns })).join('\n')}\n`);
const bytes = fs.statSync(file).size;
process.stderr.write(`wrote ${out.length} conversations, ${(bytes / 1e6).toFixed(1)} MB → ${path.relative(ROOT, file)}\n`);
