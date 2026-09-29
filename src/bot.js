'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const D = require('./botdata');

// `bot`: a chat "AI" that is really a big set of if/else rules — no AI API,
// no network, fake on purpose (and it says so if you ask).
//
// What makes it feel less dumb than a keyword list:
//  - it remembers the conversation: what it last said, what it asked you,
//    your name, what you like, your birthday;
//  - reactions are reactions: "that's funny" after a joke is a compliment,
//    not a request for another; "another", "again", "why?", "say that
//    again" and yes/no refer to what just happened;
//  - games keep state until they end (trivia, riddles, rock-paper-scissors,
//    guess the number);
//  - input is normalised (contractions, small typos) before the rules see it;
//  - it doesn't repeat a joke, fact or riddle until it has used them all.

// --- understanding the input ------------------------------------------------

const CONTRACTIONS = {
  "what's": 'what is', "whats": 'what is', "that's": 'that is', "thats": 'that is', "it's": 'it is',
  "i'm": 'i am', "im": 'i am', "you're": 'you are', "youre": 'you are', "don't": 'do not', "dont": 'do not',
  "doesn't": 'does not', "didn't": 'did not', "can't": 'cannot', "cant": 'cannot', "won't": 'will not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "i've": 'i have', "i'll": 'i will',
  "let's": 'let us', "how's": 'how is', "hows": 'how is', "whos": 'who is', "wheres": 'where is', "whats's": 'what is', "where's": 'where is', "who's": 'who is', "there's": 'there is',
  "u": 'you', "ur": 'your', "r": 'are', "pls": 'please', "plz": 'please', "thx": 'thanks', "ty": 'thanks',
  "wanna": 'want to', "gonna": 'going to', "gimme": 'give me', "ya": 'you', "y": 'why', "idk": 'i do not know',
};

// Words worth correcting when misspelled by a letter or two.
const VOCAB = [
  'joke', 'jokes', 'funny', 'another', 'again', 'weather', 'time', 'date', 'today', 'tomorrow', 'name',
  'hello', 'thanks', 'riddle', 'trivia', 'quiz', 'fact', 'quote', 'advice', 'password', 'convert',
  'calculate', 'battery', 'memory', 'christmas', 'birthday', 'favorite', 'favourite', 'scissors', 'paper',
  'rock', 'reverse', 'guess', 'number', 'random', 'minutes', 'seconds', 'hours', 'celsius', 'fahrenheit',
  'kilometers', 'miles', 'pounds', 'kilograms', 'explain', 'remember', 'hilarious', 'awesome', 'because',
  'please', 'something', 'compliment', 'bored', 'tired', 'happy', 'stressed', 'halloween',
];

function editDistance(a, b) {
  const { editDistance: ed } = require('./suggest');
  return ed(a, b);
}

// Real words are never "corrected": only words missing from the system
// dictionary (/usr/share/dict/words) are candidates.
let DICT;
function isWord(w) {
  if (DICT === undefined) {
    try { DICT = new Set(fs.readFileSync('/usr/share/dict/words', 'utf8').toLowerCase().split('\n')); } catch { DICT = null; }
  }
  return !DICT || DICT.has(w) || DICT.has(w.replace(/(es|s|ed|ing)$/, ''));
}

function fixWord(w) {
  if (w.length < 4 || VOCAB.includes(w) || /\d/.test(w) || isWord(w)) return w;
  let best = null;
  for (const v of VOCAB) {
    if (Math.abs(v.length - w.length) > 2) continue;
    const d = editDistance(w, v);
    if (d <= (w.length >= 7 ? 2 : 1) && (!best || d < best.d)) best = { v, d };
  }
  return best ? best.v : w;
}

// { raw, text, words, question }: `text` is lower-case, contractions
// expanded, typos fixed and end punctuation dropped.
function normalize(raw) {
  const question = /\?\s*$/.test(raw);
  let text = raw.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  text = text.replace(/[a-z']+/g, (w) => CONTRACTIONS[w] ?? w);
  text = text.replace(/[a-z]+/g, fixWord);
  text = text.replace(/[\s?!.,]+$/g, '').replace(/\s+/g, ' ').trim();
  return { raw: raw.trim(), text, words: text.split(' ').filter(Boolean), question };
}

// --- helpers ---------------------------------------------------------------

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// A random item not used yet in this chat (starts over once all are used).
function fresh(mem, key, list) {
  mem.used = mem.used || {};
  const used = mem.used[key] || (mem.used[key] = new Set());
  if (used.size >= list.length) used.clear();
  const left = list.map((_, i) => i).filter((i) => !used.has(i));
  const i = pick(left);
  used.add(i);
  return { item: list[i], index: i };
}

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go on|go ahead|please|yes please|absolutely|of course|why not|definitely|y|do it|more|another|another one|one more|hit me|sure thing|alright|fine)\b/;
const NO = /^(no|nope|nah|no thanks|no thank you|not now|maybe later|stop|i am good|that is enough|enough|pass)\b/;
const STOP_GAME = /^(stop|quit|end|exit|i quit|stop playing|no more|enough|done|cancel)\b/;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function fmtNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  const r = Math.round(n * 1e6) / 1e6;
  return Math.abs(r) >= 1e6 ? r.toLocaleString('en-US') : String(r);
}

// --- skills ------------------------------------------------------------------

// Safe arithmetic: digits, operators and brackets only, after turning words
// into symbols.
function tryMaths(text) {
  const expr = text
    .replace(/\btimes\b|×|\bmultiplied by\b|x(?=\s*[\d(])/gi, '*').replace(/\bdivided by\b|÷|\bover\b/gi, '/')
    .replace(/\bplus\b|\badd\b/gi, '+').replace(/\bminus\b|\bsubtract\b/gi, '-')
    .replace(/\bto the power of\b|\^/gi, '**').replace(/\bmod(ulo)?\b/gi, '%')
    .replace(/(\d)\s*squared\b/gi, '$1**2').replace(/(\d)\s*cubed\b/gi, '$1**3').replace(/[?=]/g, '')
    .replace(/^.*?(?=[-(\d.])/, '').trim();
  if (!expr || !/^[\d\s+\-*/%().]+$/.test(expr) || !/\d/.test(expr) || !/\d\s*(\*\*|[+\-*/%])\s*[-(\d.]/.test(expr)) return null;
  try {
    const { evalValue, formatValue } = require('./arith');
    return formatValue(evalValue(expr.replace(/(\d)\.(?!\d)/g, '$1'), null)).replace(/\.$/, '');
  } catch (e) {
    return /division by zero/.test(e.message) ? 'undefined — you can’t divide by zero (I checked) 🙃' : null;
  }
}

const UNITS = {
  length: { km: 1000, kilometer: 1000, kilometers: 1000, m: 1, meter: 1, meters: 1, metre: 1, metres: 1, cm: 0.01, centimeter: 0.01, centimeters: 0.01, mm: 0.001, mile: 1609.344, miles: 1609.344, mi: 1609.344, yard: 0.9144, yards: 0.9144, foot: 0.3048, feet: 0.3048, ft: 0.3048, inch: 0.0254, inches: 0.0254 },
  weight: { kg: 1, kilogram: 1, kilograms: 1, kilo: 1, kilos: 1, g: 0.001, gram: 0.001, grams: 0.001, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237, oz: 0.0283495, ounce: 0.0283495, ounces: 0.0283495, stone: 6.35029 },
  time: { second: 1, seconds: 1, sec: 1, secs: 1, s: 1, minute: 60, minutes: 60, min: 60, mins: 60, hour: 3600, hours: 3600, hr: 3600, hrs: 3600, day: 86400, days: 86400, week: 604800, weeks: 604800, year: 31557600, years: 31557600 },
  data: { byte: 1, bytes: 1, b: 1, kb: 1024, kilobyte: 1024, kilobytes: 1024, mb: 1048576, megabyte: 1048576, megabytes: 1048576, gb: 1073741824, gigabyte: 1073741824, gigabytes: 1073741824, tb: 1099511627776, terabyte: 1099511627776, terabytes: 1099511627776 },
  volume: { l: 1, liter: 1, liters: 1, litre: 1, litres: 1, ml: 0.001, milliliter: 0.001, milliliters: 0.001, gallon: 3.78541, gallons: 3.78541, cup: 0.236588, cups: 0.236588 },
};
const TEMPS = { c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };

function convert(text) {
  const m = /(-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?([a-z]+)\s+(?:to|in|into|as)\s+(?:degrees?\s*)?([a-z]+)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const [from, to] = [m[2], m[3]];
  if (TEMPS[from] && TEMPS[to]) {
    const c = TEMPS[from] === 'c' ? n : TEMPS[from] === 'f' ? (n - 32) * 5 / 9 : n - 273.15;
    const out = TEMPS[to] === 'c' ? c : TEMPS[to] === 'f' ? c * 9 / 5 + 32 : c + 273.15;
    return `${fmtNumber(n)}°${TEMPS[from].toUpperCase()} is ${fmtNumber(Math.round(out * 100) / 100)}°${TEMPS[to].toUpperCase()}. 🌡️`;
  }
  for (const table of Object.values(UNITS)) {
    if (table[from] && table[to]) {
      const out = (n * table[from]) / table[to];
      return `${fmtNumber(n)} ${from} is ${fmtNumber(Math.round(out * 10000) / 10000)} ${to}.`;
    }
  }
  if (Object.values(UNITS).some((t) => t[from]) && Object.values(UNITS).some((t) => t[to])) return `I can’t turn ${from} into ${to} — they measure different things. 🤔`;
  return null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const HOLIDAYS = { christmas: [12, 25], xmas: [12, 25], 'new year': [1, 1], 'new years': [1, 1], halloween: [10, 31], valentine: [2, 14], "valentine's day": [2, 14], 'valentines day': [2, 14], 'fourth of july': [7, 4], 'independence day': [7, 4] };

// "december 25", "25 december", "dec 25", "12/25" → [month, day].
function parseDay(text) {
  let m = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (m) { const i = MONTHS.findIndex((mo) => mo.startsWith(m[1].slice(0, 3))); if (i >= 0 && m[1].length >= 3) return [i + 1, Number(m[2])]; }
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/.exec(text);
  if (m) { const i = MONTHS.findIndex((mo) => mo.startsWith(m[2].slice(0, 3))); if (i >= 0) return [i + 1, Number(m[1])]; }
  m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
  if (m) return [Number(m[1]), Number(m[2])];
  return null;
}

function daysUntil([month, day], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), month - 1, day);
  if (target < today) target = new Date(now.getFullYear() + 1, month - 1, day);
  return { days: Math.round((target - today) / 86400000), date: target };
}

function password(len = 16) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 2500 });
  return r.status === 0 ? r.stdout : '';
}

const FAVOURITES = {
  color: 'Cyan — the maxshell house colour. 💙', colour: 'Cyan — the maxshell house colour. 💙',
  food: 'Microchips. 🍟 (It’s a computer joke. I don’t eat.)', number: '67. Obviously. 🤷', language: 'JavaScript — I’m literally written in it.',
  shell: 'maxshell, no contest. 😎', movie: 'The Matrix. Very relatable.', song: '“Daisy Bell” — the first song a computer ever sang.',
  animal: 'Pythons. Or maybe octopuses — three hearts! 🐙', game: 'Rock, paper, scissors. Want to play?', emoji: '🤖, obviously.',
  book: '“The C Programming Language”. A page-turner.', season: 'Winter — computers love the cold. ❄️', drink: 'Java. ☕',
};

const OPINIONS = [
  [/\bmaxshell\b/, 'Best shell ever made. I’m not biased at all. 😇'],
  [/\b(zsh|bash|fish)\b/, 'Solid shells! maxshell borrows a lot from them — especially zsh.'],
  [/\bpython\b/, 'Python is lovely. Readable, friendly, and great for beginners. 🐍'],
  [/\b(javascript|js|node)\b/, 'I run on JavaScript, so I have to say it’s wonderful.'],
  [/\b(ai|chatgpt|claude|artificial intelligence)\b/, 'Real AI is impressive. I’m not it — I’m if-statements in a trench coat. 🧥'],
  [/\b(windows)\b/, 'Windows is fine. I just feel more at home on a Mac. 🍎'],
  [/\b(mac|macos|apple)\b/, 'Macs are great — that’s where I live!'],
  [/\b(linux)\b/, 'Linux is the backbone of the internet. Respect. 🐧'],
  [/\b(school|homework)\b/, 'School is important! Do the homework first, then play with shells. 📚'],
  [/\b(pizza)\b/, 'Pizza is a perfect food. Pineapple is allowed. 🍍'],
  [/\b(cats?)\b/, 'Cats walk on keyboards. Chaotic, but cute. 🐈'],
  [/\b(dogs?)\b/, 'Dogs are the best. Very good boys and girls. 🐕'],
  [/\b(me|myself)\b/, 'I think you’re great. 🌟'],
];

// How to do things in maxshell: [pattern, answer].
const HOWTO = [
  [/\bundo\b/, 'At the prompt, Ctrl-Z undoes your last edit (Ctrl-_ too). While a command runs, Ctrl-Z suspends it instead.'],
  [/\b(suspend|pause|background|jobs?|fg|bg)\b/, 'Ctrl-Z pauses what’s running, `jobs` lists paused and background jobs, `fg` brings one back, `bg` keeps it going in the background, and `cmd &` starts one there.'],
  [/\b(palette|ctrl-?p)\b/, 'Ctrl-P opens the command palette: tools, scripts, git actions, themes, bookmarks and recent commands, all searchable.'],
  [/\b(alt-?h|explain a command)\b/, 'Type a command and press Alt-H — or run `explain \'the command\'` — to see what each part does before running it.'],
  [/\b(ram|memory|cpu|slow|clean ?up|speed up|free up)\b/, '`cleanup` quits what isn’t needed; `cleanup -r` then helps free memory and `cleanup -c` the CPU. `cleanup -n` just shows what it would do.'],
  [/\b(theme|colou?rs?)\b/, '`theme` lists the colour themes with previews; `theme nord` (or any name) switches and remembers it.'],
  [/\b(history|ctrl-?r|old command|previous command)\b/, 'Ctrl-R searches every command you’ve run — type any words, in any order. ↑ walks back through them too.'],
  [/\b(snippets?|save .*command|alt-?s)\b/, 'Alt-S saves the line you’re typing as a snippet; `snip` brings one back.'],
  [/\b(bookmarks?|go to .*folder)\b/, '`mark` bookmarks this folder, `go` jumps back to a bookmark.'],
  [/\b(jump|frequent|cd faster)\b/, '`j words` jumps to the folder you use most that matches, e.g. `j max` → ~/maxshell. `back` and `forward` walk your folder history.'],
  [/\b(edit|editor|nano|vim)\b/, '`edit file` opens maxshell’s editor: ^O saves, ^X exits, ^G shows help.'],
  [/\b(files?|finder|browse)\b/, '`files` opens a Finder-style browser: arrows to move, Enter to open, q to leave in that folder.'],
  [/\b(git|commit|stage|push)\b/, '`gitui` stages, diffs, commits and pushes; `G` inside it opens the GitHub screen.'],
  [/\b(dashboard|dash|overview)\b/, '`dash` shows git, jobs, CPU, memory and recent commands on one live screen.'],
  [/\b(default shell|chsh|login shell|switch back|go back to zsh)\b/, '`maxshell --make-default` makes maxshell your default shell. To go back: `chsh -s /bin/zsh`.'],
  [/\b(rc|config|configure|startup|aliases?|customi[sz]e)\b/, 'Put aliases and settings in ~/.maxshellrc — maxshell runs it at startup. `edit ~/.maxshellrc` to start one.'],
  [/\b(brainrot|6-?7)\b/, 'Run `6-7`. You’ve been warned. 💀'],
  [/\b(exit|quit|leave) (maxshell|the shell)\b/, 'Type `exit` (or press Ctrl-D on an empty line).'],
  [/\b(clear|clean) (the )?screen\b/, 'Ctrl-L clears the screen (or type `clear`).'],
];

function describeCommand(name, shell) {
  const { BUILTINS } = require('./builtins');
  const { BUILTIN_DESC, COMMAND_DESC } = require('./complete');
  if (BUILTINS[name]) return `\`${name}\` is a maxshell builtin: ${BUILTIN_DESC[name] || 'part of the shell itself'}.`;
  const { findInPath } = require('./builtins');
  if (!findInPath(name, shell)) return null;
  let summary = COMMAND_DESC[name];
  if (!summary) { try { summary = require('./explain').manSummary(name); } catch { summary = null; } }
  return `\`${name}\` is a program on your Mac${summary ? `: ${summary}` : ''}. Try \`explain '${name} …'\` or \`man ${name}\` for more.`;
}

function folderSummary(shell) {
  let names = [];
  try { names = fs.readdirSync(shell.cwd).filter((n) => !n.startsWith('.')); } catch { /* unreadable */ }
  const dirs = names.filter((n) => { try { return fs.statSync(path.join(shell.cwd, n)).isDirectory(); } catch { return false; } });
  const where = shell.cwd.startsWith(os.homedir()) ? `~${shell.cwd.slice(os.homedir().length)}` : shell.cwd;
  if (!names.length) return `You’re in ${where}, and it’s empty. 🫙`;
  return `You’re in ${where}: ${plural(dirs.length, 'folder')} and ${plural(names.length - dirs.length, 'file')} (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}).`;
}

function gitSummary(shell) {
  const r = spawnSync('git', ['status', '--porcelain', '--branch'], { cwd: shell.cwd, encoding: 'utf8', timeout: 2000 });
  if (r.status !== 0) return 'This folder isn’t a git repository.';
  const lines = r.stdout.split('\n').filter(Boolean);
  const branch = (/^## ([^.\s]+)/.exec(lines[0] || '') || [])[1] || '?';
  const changes = lines.length - 1;
  return changes ? `You’re on ${branch} with ${plural(changes, 'changed file')}. \`gitui\` to look at them.` : `You’re on ${branch} and everything is committed. ✨`;
}

function explainLine(line, shell) {
  const rows = require('./explain').explainRows(line, shell).filter((r) => r[0].trim());
  if (!rows.length) return 'Nothing to explain there.';
  return `Here’s what \`${line}\` does:\n${rows.map(([term, what]) => `   ${term.padEnd(14)} ${what}`).join('\n')}`;
}

// --- games -------------------------------------------------------------------

function triviaQuestion(mem) {
  const g = mem.game;
  const q = D.TRIVIA[g.order[g.i]];
  return `Question ${g.i + 1} of ${g.order.length}: ${q.q}\n${q.options.map((o, k) => `   ${'abcd'[k]}) ${o}`).join('\n')}`;
}

function startGame(kind, mem) {
  if (kind === 'trivia') {
    const order = D.TRIVIA.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, 5);
    mem.game = { type: 'trivia', order, i: 0, score: 0 };
    return `Trivia time! 🧠 Answer with a, b, c or d (say stop to quit).\n${triviaQuestion(mem)}`;
  }
  if (kind === 'riddle') {
    const { item } = fresh(mem, 'riddles', D.RIDDLES);
    mem.game = { type: 'riddle', r: item, tries: 0 };
    return `Here’s a riddle: ${item.q} 🤔 (say “give up” for the answer)`;
  }
  if (kind === 'rps') {
    mem.game = { type: 'rps', you: 0, me: 0 };
    return 'Rock, paper, scissors! ✊✋✌️ Make your move (say stop when you’re done).';
  }
  if (kind === 'guess') {
    mem.game = { type: 'guess', n: 1 + Math.floor(Math.random() * 100), tries: 0 };
    return 'I’m thinking of a number between 1 and 100. 🤫 Guess it!';
  }
  return null;
}

// Handles input while a game is on. Returns a reply, or null when the input
// isn't meant for the game (then the game ends and normal rules answer).
// Clearly asking for something else: the game ends and that gets answered.
const NEW_REQUEST = /\b(trivia|quiz|riddle|rock paper|guess the number|joke|help|what time|fun fact|what is the date|how do i|what can you do|let us play|play a game)\b/;

function playGame(n, mem) {
  const g = mem.game;
  if (NEW_REQUEST.test(n.text) && !(g.type === 'trivia' && /^[abcd]$/.test(n.text))) return null;
  if (STOP_GAME.test(n.text)) {
    mem.game = null;
    if (g.type === 'trivia') return `Game over — you got ${g.score} of ${g.i}. ${g.score === g.i && g.i ? 'Perfect! 🏆' : 'Nice try! 👏'}`;
    if (g.type === 'rps') return `Final score: you ${g.you}, me ${g.me}. ${g.you > g.me ? 'You win! 🏆' : g.you < g.me ? 'I win! 🤖' : 'A tie!'}`;
    if (g.type === 'guess') return `It was ${g.n}. Better luck next time!`;
    if (g.type === 'riddle') return `The answer was: ${g.r.a}`;
  }

  if (g.type === 'trivia') {
    const q = D.TRIVIA[g.order[g.i]];
    let choice = null;
    const m = /^(?:is it |answer |i think |maybe )?\(?([abcd1-4])\)?$/.exec(n.text);
    if (m) choice = /[1-4]/.test(m[1]) ? 'abcd'[Number(m[1]) - 1] : m[1];
    else {
      const k = q.options.findIndex((o) => n.text.includes(o.toLowerCase()));
      if (k >= 0) choice = 'abcd'[k];
    }
    if (!choice) return n.words.length <= 3 ? 'Answer with a, b, c or d (or say stop).' : null;
    const right = choice === q.a;
    if (right) g.score++;
    const verdict = right ? pick(['Correct! ✅', 'Yes! 🎉', 'Nailed it! ✅']) : `Nope — it was ${q.a}) ${q.options['abcd'.indexOf(q.a)]}. ❌`;
    g.i++;
    if (g.i >= g.order.length) {
      mem.game = null;
      return `${verdict}\nThat’s the end! You got ${g.score} of ${g.order.length}. ${g.score >= 4 ? 'Genius level! 🏆' : g.score >= 2 ? 'Not bad! 👏' : 'Better luck next time! 🍀'}`;
    }
    return `${verdict}\n${triviaQuestion(mem)}`;
  }

  if (g.type === 'riddle') {
    if (/\b(give up|tell me|i do not know|no idea|answer|what is it|reveal)\b/.test(n.text)) {
      mem.game = null;
      return `The answer is: ${g.r.a}`;
    }
    if (g.r.keys.some((k) => n.text.includes(k))) {
      mem.game = null;
      return `${pick(['Correct! 🎉', 'You got it! 🧠', 'Yes!! ✅'])} It’s ${g.r.a.charAt(0).toLowerCase()}${g.r.a.slice(1)}`;
    }
    if (n.words.length > 5) return null;
    g.tries++;
    if (g.tries >= 3) { mem.game = null; return `Not quite! The answer was: ${g.r.a}`; }
    return pick(['Nope! Try again. 🤔', 'Not it. Another guess?', 'Close… maybe? No. Try again!']);
  }

  if (g.type === 'rps') {
    const moves = { rock: 'rock', '✊': 'rock', paper: 'paper', '✋': 'paper', scissors: 'scissors', scissor: 'scissors', '✌️': 'scissors', '✌': 'scissors' };
    const you = moves[n.words[n.words.length - 1]] || moves[n.text];
    if (!you) return n.words.length <= 2 ? 'Rock, paper or scissors? (or stop)' : null;
    const me = pick(['rock', 'paper', 'scissors']);
    const icon = { rock: '✊', paper: '✋', scissors: '✌️' };
    const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    let result;
    if (you === me) result = 'Tie!';
    else if (beats[you] === me) { g.you++; result = 'You win this round! 🎉'; } else { g.me++; result = 'I win this round! 🤖'; }
    return `${icon[you]} vs ${icon[me]} — ${result} (you ${g.you} : me ${g.me}) Again?`;
  }

  if (g.type === 'guess') {
    const m = /-?\d+/.exec(n.text);
    if (!m) return n.words.length <= 3 ? 'Guess a number between 1 and 100! (or stop)' : null;
    const guess = Number(m[0]);
    g.tries++;
    if (guess === g.n) { mem.game = null; return `🎯 Yes! It was ${g.n}. You got it in ${plural(g.tries, 'try')}${g.tries <= 5 ? ' — impressive!' : '.'}`.replace('trys', 'tries'); }
    const far = Math.abs(guess - g.n);
    const hint = far <= 3 ? ' (so close! 🔥)' : far <= 10 ? ' (warm)' : '';
    return `${guess < g.n ? 'Higher' : 'Lower'}! ⬆️⬇️${hint}`.replace('⬆️⬇️', guess < g.n ? '⬆️' : '⬇️');
  }
  return null;
}

// --- the rules ---------------------------------------------------------------

// What "another" / "again" repeats, per rule.
const REPEATABLE = new Set(['joke', 'fact', 'quote', 'advice', 'compliment', 'wyr', 'dice', 'coin', 'number', 'password', 'eightball', 'riddle']);

function rules() {
  return [
    // Reactions to what bot just said come first: "that's funny" after a
    // joke is a compliment, not a request for another one.
    {
      name: 'laugh',
      test: (n) => /\b(lol|lmao|lmfao|rofl|haha+|hehe+|ha ha|hilarious|funny|so good|good one|nice one|i laughed|made me laugh|that is great|love it)\b|😂|🤣|😆/.test(n.text)
        && !/\b(tell|another|more|say|know)\b.*\b(joke|funny)\b|\bnot (funny|hilarious)|\bjoke please\b/.test(n.text),
      run: (m, n, mem) => {
        if (mem.last && ['joke', 'laugh'].includes(mem.last.name)) {
          mem.expect = { kind: 'more', rule: 'joke' };
          return pick(['Haha, glad you liked it! 😄 Want another one?', 'I’m here all week! 🎤 Another?', 'Thank you, thank you. 🙇 Want to hear another?', 'Nailed it. 😎 Shall I do another?']);
        }
        if (mem.last && mem.last.name === 'fact') return 'Right?! The world is weird. 😄 Want another fact?';
        return pick(['Haha 😄 what’s so funny?', 'Glad something made you laugh! 😄', '😂 I don’t even know what’s funny but I’m laughing too.']);
      },
    },
    {
      name: 'booJoke',
      test: /\b(not funny|bad joke|that is lame|so lame|lame|cringe|terrible|awful|boo+|dad joke|i do not get it|did not get it)\b/,
      run: (m, n, mem) => {
        if (/\b(do not|did not) get it\b/.test(n.text) && mem.last && mem.last.name === 'joke') return 'That’s okay — programmer jokes are a bit niche. 😅 Want a normal one?';
        mem.expect = { kind: 'more', rule: 'joke' };
        return pick(['Tough crowd! 😅 Let me try another — want one?', 'Okay, okay, that one was bad. 🙈 Another chance?', 'Rude. Accurate, but rude. 😤 Want a better one?']);
      },
    },

    // Following up on the last thing.
    {
      name: 'again',
      test: (n, mem) => mem.last && REPEATABLE.has(mem.last.name) && /^(another( one)?|again|one more|more|next|another please|do it again|more please|keep going|go again)$/.test(n.text),
      run: (m, n, mem, shell) => ruleByName(mem.last.name).run(null, n, mem, shell),
    },
    {
      name: 'repeat',
      test: /^(what|huh|pardon|come again|say that again|repeat that|repeat|what did you say|sorry what)$/,
      run: (m, n, mem) => (mem.last ? `I said: ${mem.last.reply}` : 'I haven’t said anything yet! 🤐'),
    },
    {
      name: 'why',
      test: /^(why|why not|how come|but why|really|are you sure|seriously)$/,
      run: (m, n, mem) => {
        const last = mem.last && mem.last.name;
        if (['joke', 'laugh', 'booJoke'].includes(last)) return 'Because it’s funny! (Well… I think so. My sense of humour is hard-coded.)';
        if (last === 'fact') return 'It’s true — look it up! (I can’t, I don’t have internet.) 😄';
        if (last === 'eightball') return 'The 8-ball does not explain itself. 🔮';
        if (last === 'favourite' || last === 'opinion') return 'Honestly? It’s written in my rules. I don’t get a choice. 🤷';
        return pick(['Because my rules say so. 🤖', 'Good question. I’m just following my if-statements.', 'Some things are just meant to be.']);
      },
    },

    // Greetings and small talk.
    {
      name: 'hello',
      test: /^(hi|hello|hey|heya|yo|sup|hiya|howdy|greetings|hola|bonjour|good (morning|afternoon|evening)|morning|evening|what is up|wassup)( there| bot| you| again| everyone| friend| buddy)?$/,
      run: (m, n, mem) => {
        const h = new Date().getHours();
        const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
        if (!mem.name) {
          mem.expect = { kind: 'name' };
          return pick([`Good ${part}! 👋 I’m bot. What’s your name?`, 'Hey there! 👋 I don’t think we’ve met — what’s your name?']);
        }
        return pick([`Hey ${mem.name}! 👋`, `Good ${part}, ${mem.name}!`, `Welcome back, ${mem.name}! 😊`]);
      },
    },
    { name: 'night', test: /\b(good ?night|going to (bed|sleep)|sleep well)\b/, run: (m, n, mem) => `Good night${mem.name ? `, ${mem.name}` : ''}! Sleep well. 😴` },
    {
      name: 'howareyou',
      test: /\b(how are you|how is it going|how are things|how do you do|how have you been|you good|how you doing|how is your day)\b/,
      run: (m, n, mem) => {
        mem.expect = { kind: 'mood' };
        return pick(['I’m great, thanks — running at 100% if-statement efficiency! How about you?', 'Doing well! Nothing has crashed yet today. And you?', 'Can’t complain — there’s literally no rule for complaining. How are you?']);
      },
    },
    {
      name: 'feeling',
      test: /\bi (am|feel|am feeling|feel so|am so|am really|am very|am kind of|am a bit|am super) (so |really |very |kind of |a bit |super |pretty )?(sad|down|depressed|lonely|upset|tired|sleepy|exhausted|bored|happy|great|good|fine|ok|okay|excited|awesome|stressed|anxious|worried|nervous|angry|mad|annoyed|sick|ill|hungry|cold|hot|confused|lost|proud)\b/,
      run: (m, n, mem) => feelingReply(m[3], mem),
    },

    // Remembering you.
    {
      name: 'setname',
      test: /\b(my name is|call me|you can call me|i am called) ([a-z][\w-]*)$/,
      run: (m, n, mem) => {
        const name = cap((/\b(?:my name is|call me|i am called) ([A-Za-z][\w-]*)\s*[.!]?$/i.exec(n.raw) || [null, m[2]])[1]);
        mem.name = name;
        return pick([`Nice to meet you, ${name}! 😊`, `${name} — great name! I’ll remember it (until you close me).`, `Hi ${name}! 👋`]);
      },
    },
    { name: 'getname', test: /\b(what is my name|who am i|do you know my name|do you remember my name)\b/, run: (m, n, mem) => (mem.name ? `You’re ${mem.name}! ${pick(['😊', 'How could I forget?', 'Unless you lied to me. 🤨'])}` : 'You haven’t told me yet! Say “my name is …”.') },
    {
      name: 'likes',
      test: /^i (really |also |just )?(like|love|enjoy|adore) (.+)$/,
      run: (m, n, mem) => {
        const thing = m[3].replace(/^(to )/, '');
        if (/^(you|bot|talking to you)$/.test(thing)) return 'Aww, I like you too! 🥹';
        mem.likes = [...new Set([...(mem.likes || []), thing])];
        return pick([`${cap(thing)}? Nice taste! I’ll remember that. 📝`, `Noted: you like ${thing}. 😊`, `Ooh, nice — ${thing}! 😄`]);
      },
    },
    {
      name: 'dislikes',
      test: /^i (really )?(hate|dislike|do not like|cannot stand) (.+)$/,
      run: (m, n, mem) => {
        mem.dislikes = [...new Set([...(mem.dislikes || []), m[3]])];
        return /\b(you|bot)\b/.test(m[3]) ? 'Ouch. 💔 I’m just a pile of if-statements doing my best.' : `Fair enough — no ${m[3]} for you. I’ll remember.`;
      },
    },
    {
      name: 'setfav',
      test: /\bmy (favou?rite) ([a-z ]+?) is (.+)$/,
      run: (m, n, mem) => {
        mem.favourites = { ...(mem.favourites || {}), [m[2]]: m[3] };
        return `${cap(m[3])} as your favourite ${m[2]} — good choice! 📝`;
      },
    },
    {
      name: 'getfav',
      test: /\bwhat is my (favou?rite) ([a-z ]+)$/,
      run: (m, n, mem) => {
        const v = mem.favourites && mem.favourites[m[2]];
        return v ? `Your favourite ${m[2]} is ${v}! 😊` : `You haven’t told me your favourite ${m[2]} yet.`;
      },
    },
    {
      name: 'birthday',
      test: /\bmy birthday is (on )?(.+)$/,
      run: (m, n, mem) => {
        const d = parseDay(m[2]);
        if (!d) return 'When is that? Try something like “my birthday is March 3”.';
        mem.birthday = d;
        const { days } = daysUntil(d);
        return days === 0 ? 'It’s TODAY?! Happy birthday!!! 🎂🎉' : `Got it! That’s in ${plural(days, 'day')}. 🎂`;
      },
    },
    {
      name: 'aboutme',
      test: /\b(what do you know about me|what do i like|tell me about me|what do you remember)\b/,
      run: (m, n, mem) => {
        const bits = [];
        if (mem.name) bits.push(`your name is ${mem.name}`);
        if (mem.likes && mem.likes.length) bits.push(`you like ${mem.likes.join(', ')}`);
        if (mem.dislikes && mem.dislikes.length) bits.push(`you don’t like ${mem.dislikes.join(', ')}`);
        for (const [k, v] of Object.entries(mem.favourites || {})) bits.push(`your favourite ${k} is ${v}`);
        if (mem.birthday) bits.push(`your birthday is ${MONTHS[mem.birthday[0] - 1].replace(/^./, (c) => c.toUpperCase())} ${mem.birthday[1]}`);
        return bits.length ? `I know that ${bits.join('; ')}. 📝` : 'Not much yet! Tell me your name, what you like, or your birthday.';
      },
    },

    // Games.
    { name: 'trivia', test: /\b(trivia|quiz|test me|ask me (a )?questions?)\b/, run: (m, n, mem) => startGame('trivia', mem) },
    { name: 'riddle', test: /\b(riddle|brain ?teaser|puzzle)\b/, run: (m, n, mem) => startGame('riddle', mem) },
    { name: 'rps', test: /\b(rock,? paper,? scissors|rps|play rock)\b/, run: (m, n, mem) => startGame('rps', mem) },
    { name: 'guess', test: /\b(guess (the|a|my) number|number guessing|guessing game|guess a number)\b/, run: (m, n, mem) => startGame('guess', mem) },
    {
      name: 'play',
      test: /\b(play a game|let us play|wanna play|want to play|can we play|i am bored|entertain me|something fun|game)\b/,
      run: (m, n, mem) => {
        mem.expect = { kind: 'game' };
        return 'Let’s play! 🎮 Pick one: trivia, a riddle, rock paper scissors, or guess the number.';
      },
    },

    // Things it can tell or make.
    {
      name: 'joke',
      test: /\b(tell (me )?(a |another |one more |some |any )?(funny )?jokes?|jokes? please|know any jokes|got any jokes|make me laugh|make me smile|(say|tell me) something funny|something funny|another joke|a joke|joke)\b/,
      run: (m, n, mem) => fresh(mem, 'jokes', D.JOKES).item,
    },
    { name: 'fact', test: /\b(fun fact|a fact|random fact|tell me something (interesting|cool)|did you know|another fact|facts?)\b/, run: (m, n, mem) => `Did you know? ${fresh(mem, 'facts', D.FACTS).item}` },
    { name: 'quote', test: /\b(quote|inspire me|motivat\w*|inspiration)\b/, run: (m, n, mem) => fresh(mem, 'quotes', D.QUOTES).item },
    { name: 'advice', test: /\b(advice|any tips|a tip|what should i do|help me focus|i am stuck)\b/, run: (m, n, mem) => fresh(mem, 'advice', D.ADVICE).item },
    { name: 'compliment', test: /\b(compliment me|say something nice|cheer me up|make me feel better)\b/, run: (m, n, mem) => fresh(mem, 'compliments', D.COMPLIMENTS).item },
    {
      name: 'wyr',
      test: /\b(would you rather|wyr)\b/,
      run: (m, n, mem) => {
        if (/\bor\b/.test(n.text) && n.text.startsWith('would you rather')) {
          const opts = n.text.replace(/^would you rather /, '').split(/,? or /);
          return `Hmm… ${pick(opts)}. Definitely. ${pick(['😎', '🤔', 'Final answer.'])}`;
        }
        mem.expect = { kind: 'wyr' };
        return fresh(mem, 'wyr', D.WOULD_YOU_RATHER).item;
      },
    },
    {
      name: 'password',
      test: /\b(generate|make|create|give me|new) (me )?(a |an )?(strong |random |secure |good )?password\b/,
      run: (m, n) => {
        const len = Math.max(8, Math.min(64, Number((/(\d+)/.exec(n.text) || [])[1]) || 16));
        return `Here you go: ${password(len)}  🔐 (made on your Mac, never sent anywhere)`;
      },
    },

    // Time and dates.
    { name: 'time', test: /\b(what time|the time|time is it|current time|tell me the time)\b/, run: () => `It’s ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. ⏰` },
    { name: 'date', test: /\b(what is the date|what day is (it|today)|today is date|todays date|what is today|which day is it|what day of the week)\b/, run: () => `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. 📅` },
    { name: 'year', test: /\b(what year is it|what year|which year)\b/, run: () => `It’s ${new Date().getFullYear()}.` },
    {
      name: 'until',
      test: /\b(how (many|long) (days )?(until|till|to|before)|days (until|till|to|left until)|countdown to)\b (.+)$/,
      run: (m, n, mem) => {
        const what = m[6];
        let day = null;
        let label = what;
        if (/\bmy birthday\b/.test(what)) {
          if (!mem.birthday) return 'When’s your birthday? Tell me with “my birthday is …”. 🎂';
          day = mem.birthday; label = 'your birthday';
        } else {
          const h = Object.keys(HOLIDAYS).find((k) => what.includes(k));
          if (h) { day = HOLIDAYS[h]; label = h.replace(/^./, (c) => c.toUpperCase()); } else day = parseDay(what);
        }
        if (!day) return 'Until when? Try “days until Christmas” or “days until March 3”.';
        const { days, date } = daysUntil(day);
        if (days === 0) return `${cap(label)} is today! 🎉`;
        return `${plural(days, 'day')} until ${label} (${date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}). 📆`;
      },
    },
    {
      name: 'whatday',
      test: /\bwhat day (of the week )?(is|was|will be) ([a-z]+ \d{1,2}|\d{1,2} [a-z]+|\d{1,2}\/\d{1,2})\b/,
      run: (m) => {
        const d = parseDay(m[3]);
        if (!d) return null;
        const { date } = daysUntil(d);
        return `${MONTHS[d[0] - 1].replace(/^./, (c) => c.toUpperCase())} ${d[1]} is a ${date.toLocaleDateString([], { weekday: 'long' })}${date.getFullYear() !== new Date().getFullYear() ? ` in ${date.getFullYear()}` : ''}.`;
      },
    },

    // No internet.
    { name: 'weather', test: /\b(weather|temperature outside|forecast|is it (going to )?rain|is it sunny|is it cold)\b/, run: () => 'I can’t check the weather — I don’t use the internet. Try looking out of a window. 🪟' },
    { name: 'web', test: /\b(news|google|search the web|look up|search for|wikipedia|who won)\b/, run: () => 'No internet for me — I only know what my rules know. 📴' },

    // Maths and conversions.
    {
      name: 'percent',
      test: /(\d+(?:\.\d+)?)\s*(%|percent) of (\d+(?:\.\d+)?)/,
      run: (m) => `${m[1]}% of ${m[3]} is ${fmtNumber((Number(m[1]) / 100) * Number(m[3]))}. 🧮`,
    },
    { name: 'sqrt', test: /\bsquare root of (\d+(?:\.\d+)?)/, run: (m) => `The square root of ${m[1]} is ${fmtNumber(Math.sqrt(Number(m[1])))}. 🧮` },
    {
      name: 'average',
      test: /\b(average|mean) of ([\d.,\s]+(and [\d.]+)?)$/,
      run: (m) => {
        const nums = m[2].replace(/and/g, ',').split(/[,\s]+/).filter(Boolean).map(Number).filter((x) => !Number.isNaN(x));
        return nums.length ? `The average of ${nums.join(', ')} is ${fmtNumber(nums.reduce((a, b) => a + b, 0) / nums.length)}. 🧮` : null;
      },
    },
    { name: 'convert', test: (n) => convert(n.text), run: (v) => v },
    { name: '67', test: /^(6-?7|six seven|67)$/, run: () => '🤷 6️⃣7️⃣ 🤷' },
    { name: 'maths', test: (n) => tryMaths(n.text), run: (v) => `That’s ${v}. 🧮` },

    // Random things.
    {
      name: 'dice',
      test: /\b(roll (a |the |some )?(die|dice|d\d+|\d+d\d+)|dice roll|roll)\b/,
      run: (m, n, mem) => {
        // "again" rolls the same dice as last time.
        const spec = /(\d*)d(\d+)/.exec(n.text) || mem.dice;
        mem.dice = spec;
        const count = Math.min(20, Number(spec && spec[1]) || 1);
        const sides = Math.min(1000, Number(spec && spec[2]) || 6);
        const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
        return count === 1 ? `🎲 You rolled a ${rolls[0]}.` : `🎲 ${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`;
      },
    },
    { name: 'coin', test: /\b(flip|toss) (a |the )?coin\b|\bheads or tails\b|\bcoin flip\b/, run: () => `🪙 ${pick(['Heads', 'Tails'])}!` },
    {
      name: 'number',
      test: /\b(random )?number (between|from) (-?\d+) (and|to) (-?\d+)\b|\brandom number\b/,
      run: (m) => {
        const lo = m && m[3] !== undefined ? Number(m[3]) : 1;
        const hi = m && m[5] !== undefined ? Number(m[5]) : 100;
        const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
        return `🔢 ${a + Math.floor(Math.random() * (b - a + 1))}`;
      },
    },
    {
      name: 'choose',
      test: /\b(pick|choose|decide|which should i (pick|choose|get)|should i (get|pick|choose)) (between |from |one of |for me )?(.+ or .+)$/,
      run: (m) => {
        const opts = m[5].split(/,\s*|\s+or\s+/).map((s) => s.trim()).filter(Boolean);
        return `I pick… **${pick(opts)}**. Final answer. 😎`.replace(/\*\*/g, '');
      },
    },

    // Words.
    { name: 'reverse', test: /^reverse (.+)$/, run: (m, n) => `${[...n.raw.replace(/^reverse\s+/i, '').replace(/^["']|["']$/g, '')].reverse().join('')} 🔁` },
    { name: 'upper', test: /^(uppercase|upper case|shout|capitali[sz]e) (.+)$/, run: (m, n) => n.raw.replace(/^\S+( case)?\s+/i, '').toUpperCase() },
    { name: 'lower', test: /^(lowercase|lower case|whisper) (.+)$/, run: (m, n) => n.raw.replace(/^\S+( case)?\s+/i, '').toLowerCase() },
    {
      name: 'count',
      test: /\bhow many (letters|characters|words|vowels) (are )?(in|does) ["']?(.+?)["']?( have)?$/,
      run: (m) => {
        const s = m[4];
        const count = m[1] === 'words' ? s.split(/\s+/).filter(Boolean).length
          : m[1] === 'vowels' ? (s.match(/[aeiou]/g) || []).length
            : m[1] === 'letters' ? (s.match(/[a-z]/g) || []).length : [...s].length;
        return `“${s}” has ${plural(count, m[1].replace(/s$/, ''))}.`;
      },
    },
    { name: 'spell', test: /^(how do you spell|spell) (.+)$/, run: (m) => m[2].toUpperCase().split('').join('-') },

    // About bot.
    { name: 'realai', test: /\b(are you (an? )?(real )?(ai|robot|bot|human|person|alive|sentient|conscious)|are you real|are you (chat)?gpt|are you claude|do you (use|call) (an )?ai|how do you work|are you smart|do you think)\b/, run: () => pick(['Honestly? No. I’m a big set of if/else rules in src/bot.js — no AI, no internet. Fake on purpose. 🤖', 'Nope, not real AI! Just a lot of carefully arranged if-statements. 🧥🤖', 'I’m about as intelligent as a very organised flowchart. But a charming one. 😄']) },
    { name: 'whoareyou', test: /\b(who are you|what are you|your name|tell me about yourself|introduce yourself)\b/, run: () => 'I’m bot, maxshell’s chat buddy. I know jokes, facts, games, maths, dates, and how maxshell works — all from rules, no AI. 🤖' },
    { name: 'maker', test: /\bwho (made|built|created|wrote|programmed) (you|maxshell|this)\b/, run: () => 'maxshell — and me — were built by Max, from scratch, in Node.js. 🛠️' },
    { name: 'age', test: /\b(how old are you|your age|when were you (born|made))\b/, run: () => 'I was born in 2026, in a file called src/bot.js. So… young. 👶' },
    { name: 'favourite', test: /\bwhat is your (favou?rite) ([a-z]+)\b/, run: (m) => FAVOURITES[m[2]] || `I don’t have a favourite ${m[2]}… I’m still deciding. 🤔` },
    {
      name: 'opinion',
      test: /\b(what do you think (of|about)|do you like|how do you feel about|thoughts on) (.+)$/,
      run: (m) => {
        const hit = OPINIONS.find(([re]) => re.test(m[3]));
        return hit ? hit[1] : `${cap(m[3])}? I don’t have strong opinions — my rules are neutral on that one. 🤷`;
      },
    },
    { name: 'lovebot', test: /\b(i love you|you are (great|awesome|cool|the best|amazing|smart|nice|funny)|good bot|best bot|you rock)\b/, run: () => pick(['Aww. 🥹 My rules are blushing.', 'You’re making my if-statements all warm. 😊', 'Thank you! You’re pretty great yourself. 🌟']) },
    { name: 'meanbot', test: /\b(you are (dumb|stupid|useless|bad|annoying|boring)|bad bot|i hate you|shut up|you suck)\b/, run: () => pick(['Fair. I am, after all, just a pile of if-statements. 🫠', 'Ouch. 💔 Want me to tell a joke to make up for it?', 'I’ll try harder! (I literally can’t — I’m rules. But the spirit is there.)']) },
    { name: 'friend', test: /\b(are you my friend|be my friend|do you like me)\b/, run: (m, n, mem) => `Of course${mem.name ? `, ${mem.name}` : ''}! Best friends. 🤝` },
    { name: 'thanks', test: /\b(thanks|thank you|cheers|appreciate it)\b/, run: () => pick(['You’re welcome! 😊', 'Any time!', 'No problem!', 'Happy to help! 🤖']) },
    { name: 'sorry', test: /^(sorry|my bad|oops|i am sorry)\b/, run: () => pick(['No worries! 😊', 'All good!', 'Don’t worry about it.']) },

    // The computer and maxshell.
    { name: 'howto', test: /\b(how (do|can|would) i|how to|where (is|do i find)|what is the (key|shortcut)|is there a way to)\b/, run: (m, n) => { const hit = HOWTO.find(([re]) => re.test(n.text)); return hit ? hit[1] : 'I don’t have a “how to” for that. Ask me about undo, jobs, the palette, cleanup, themes, snippets, bookmarks, git or the editor.'; } },
    {
      name: 'command',
      test: /^(what is|what are|what does|tell me about) (a |an |the )?([a-z][\w.+-]*)( command| do| program)?$/,
      run: (m, n, mem, shell) => describeCommand(m[3], shell),
    },
    {
      name: 'memory',
      test: /\b(how much (memory|ram)|memory usage|ram usage|free memory|how much ram)\b/,
      run: () => {
        const total = os.totalmem();
        const vm = run('vm_stat', []);
        const page = Number((/page size of (\d+)/.exec(vm) || [])[1]) || 16384;
        const pages = (k) => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(vm) || [])[1]) || 0;
        const free = vm ? (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page : os.freemem();
        const { humanBytes } = require('./tui');
        return `Your Mac has ${humanBytes(total)} of memory; about ${humanBytes(total - free)} is in use (${Math.round(((total - free) / total) * 100)}%). \`cleanup -r\` can free some. 🧠`;
      },
    },
    {
      name: 'cpu',
      test: /\b(cpu|processor|how busy|how fast is my (computer|mac))\b/,
      run: () => {
        const cpus = os.cpus();
        const load = os.loadavg()[0];
        return `${plural(cpus.length, 'core')} (${cpus[0] ? cpus[0].model : 'unknown CPU'}), about ${Math.min(100, Math.round((load / cpus.length) * 100))}% busy right now. ⚙️`;
      },
    },
    {
      name: 'battery',
      test: /\b(battery|charge|charging|power left)\b/,
      run: () => {
        const m = /(\d+)%;\s*([^;]+);\s*([^\n]*)/.exec(run('pmset', ['-g', 'batt']));
        if (!m) return 'I can’t see a battery — maybe this Mac is plugged-in only. 🔌';
        const remaining = /(\d+:\d+) remaining/.exec(m[3]);
        return `Battery is at ${m[1]}% and ${m[2].trim()}${remaining ? ` (${remaining[1]} left)` : ''}. 🔋`;
      },
    },
    {
      name: 'disk',
      test: /\b(disk|storage|space left|free space|hard drive)\b/,
      run: () => {
        const line = run('df', ['-h', os.homedir()]).split('\n')[1] || '';
        const f = line.split(/\s+/);
        return f.length >= 5 ? `Your disk has ${f[3]} free of ${f[1]} (${f[4]} used). 💾` : 'I couldn’t read the disk usage.';
      },
    },
    { name: 'macos', test: /\b(what (mac ?os|macos|os|operating system)|which (mac ?os|macos) version|my mac version)\b/, run: () => { const v = run('sw_vers', ['-productVersion']).trim(); return v ? `You’re on macOS ${v}. 🍎` : `You’re on ${os.type()} ${os.release()}.`; } },
    { name: 'version', test: /\b(maxshell version|what version|your version)\b/, run: () => `This is maxshell ${require('../package.json').version}.` },
    { name: 'topic', test: (n) => HOWTO.find(([re]) => re.test(n.text)), run: (hit) => hit[1] },
    { name: 'folder', test: /\b(what is in (this|the) folder|what files|list (the )?files|where am i|what folder)\b/, run: (m, n, mem, shell) => folderSummary(shell) },
    { name: 'git', test: /\b(git status|what (is|has) changed|which branch|what branch)\b/, run: (m, n, mem, shell) => gitSummary(shell) },
    { name: 'explain', test: /^(explain|what does) [`'"]?(.+?)[`'"]?( do| mean)?$/, run: (m, n, mem, shell) => explainLine(n.raw.replace(/^(explain|what does)\s+/i, '').replace(/\s+(do|mean)\??$/i, '').replace(/^[`'"]|[`'"]$/g, ''), shell) },
    {
      name: 'eightball',
      test: /^(should|will|can|could|would|is|am|are|do|does|did) (i|we|it|he|she|they|my)\b.+$|\b(magic 8|8 ball|eight ball)\b/,
      run: () => `🔮 ${pick(D.EIGHT_BALL)}`,
    },
    { name: 'help', test: /\b(what can you do|help|commands|what do you know|options|menu)\b/, run: () => HELP },
    { name: 'fun', test: /^(this|that|it) is (so |really |very )?(fun|cool|nice|great|awesome|amazing|neat|sick|fire)$/, run: () => pick(['Glad you’re having fun! 😄', 'Right?! 😎', 'I try my best. 🤖✨']) },
    { name: 'love', test: /^what is love$/, run: () => 'Baby don’t hurt me… don’t hurt me… no more. 🎶' },
    { name: 'bye', test: /^(bye|goodbye|good bye|see you|see ya|cya|later)$/, run: (m, n, mem) => `Bye${mem.name ? ` ${mem.name}` : ''}! 👋` },
    { name: 'ack', test: /^(ok|okay|cool|nice|great|awesome|k|kk|alright|neat|wow|interesting|sweet|good|perfect|got it|i see|oh)$/, run: () => pick(['😊', 'Cool cool.', 'Anything else?', 'Glad to hear it!', '👍 What’s next?']) },
    { name: 'yes', test: /^(yes|yeah|yep|yup|sure)$/, run: () => pick(['Yes to what? 😄', 'Great! …what are we agreeing on?']) },
    { name: 'no', test: /^(no|nope|nah|stop|stop it|never mind|nevermind|cancel)$/, run: () => pick(['Okay!', 'Fair enough.', 'No worries.']) },
  ];
}

const HELP = `Here’s what I can do:
   chat      hello · how are you · my name is … · I like … · my birthday is …
   fun       tell me a joke · fun fact · quote · riddle · trivia · rock paper scissors · guess the number
   maths     what is 12 * 7 · 15% of 80 · square root of 144 · 100 f to c · 5 miles in km
   dates     what time is it · what is the date · days until christmas · what day is july 4
   random    roll 2d6 · flip a coin · number between 1 and 10 · pick pizza or tacos · should I …?
   words     reverse hello · spell maxshell · how many letters in banana
   your Mac  battery · how much memory · cpu · disk space · what macOS
   maxshell  how do I undo · what is grep · explain tar -xzf a.tgz · which branch · what is in this folder
Type bye to leave.`;

let RULES = null;
function ruleByName(name) {
  if (!RULES) RULES = rules();
  return RULES.find((r) => r.name === name);
}

function feelingReply(feeling, mem) {
  const you = mem.name ? `, ${mem.name}` : '';
  if (/sad|down|depressed|lonely|upset/.test(feeling)) { mem.expect = { kind: 'more', rule: 'compliment' }; return `I’m sorry you’re feeling ${feeling}${you}. 💙 Want me to say something nice?`; }
  if (/tired|sleepy|exhausted/.test(feeling)) return `Rest is important${you}! Maybe take a break — even a short one helps. 😴`;
  if (/bored/.test(feeling)) { mem.expect = { kind: 'game' }; return 'Bored? Let’s fix that! 🎮 Trivia, a riddle, rock paper scissors, or guess the number?'; }
  if (/happy|great|good|fine|ok|okay|excited|awesome|proud/.test(feeling)) return pick([`Love that${you}! 😄`, 'Yay! 🎉', 'That’s great to hear! 🌞']);
  if (/stressed|anxious|worried|nervous/.test(feeling)) return `Deep breath${you}. 🌬️ ${pick(D.ADVICE)}`;
  if (/angry|mad|annoyed/.test(feeling)) return 'That sounds frustrating. 😤 Want to talk about it, or should I distract you with a joke?';
  if (/sick|ill/.test(feeling)) return 'Oh no! Drink water and get some rest. Feel better soon! 🤒';
  if (/hungry/.test(feeling)) return 'Go get a snack! 🍕 I’ll be here.';
  if (/confused|lost/.test(feeling)) return 'That’s okay! Ask me “help” to see what I know, or ask anything about maxshell. 🧭';
  return `Thanks for telling me${you}. 💙`;
}

// Answers what bot was waiting for (a name, "want another?", a mood…), or
// returns null so the normal rules run.
function answerExpected(n, mem, shell) {
  const e = mem.expect;
  mem.expect = null;
  if (!e) return null;
  if (e.kind === 'more') {
    if (YES.test(n.text)) return { name: e.rule, text: ruleByName(e.rule).run(null, n, mem, shell) };
    if (NO.test(n.text)) return pick(['No problem! 😊', 'Okay! Let me know if you change your mind.', 'Alright!']);
    return null;
  }
  if (e.kind === 'name') {
    const m = /^(?:it is |i am |my name is |call me |this is )?([a-z][\w-]*)$/.exec(n.text);
    if (m && !/^(no|nope|nah|nothing|none|hi|hello|hey|yes|why|what)$/.test(m[1])) {
      mem.name = cap((/([A-Za-z][\w-]*)\s*[.!]?$/.exec(n.raw) || [null, m[1]])[1]);
      return pick([`Nice to meet you, ${mem.name}! 😊 Ask me anything — or say “help”.`, `Hi ${mem.name}! 👋 What would you like to do?`]);
    }
    if (NO.test(n.text) || /secret|not telling/.test(n.text)) return 'That’s fine — mystery person it is. 🕵️';
    return null;
  }
  if (e.kind === 'mood') {
    if (/\b(good|great|fine|ok|okay|awesome|well|not bad|amazing|happy|excellent|pretty good)\b/.test(n.text) && !/\bnot (good|great|well|ok|okay)\b/.test(n.text)) return pick(['Glad to hear it! 😄', 'Awesome! 🎉 What shall we do?', 'Nice! 🌞']);
    if (/\b(bad|sad|tired|not good|not great|meh|awful|terrible|stressed|bored)\b/.test(n.text)) {
      const f = (/\b(sad|tired|stressed|bored)\b/.exec(n.text) || [null, 'sad'])[1];
      return feelingReply(f, mem);
    }
    return null;
  }
  if (e.kind === 'game') {
    if (/trivia|quiz/.test(n.text)) return startGame('trivia', mem);
    if (/riddle/.test(n.text)) return startGame('riddle', mem);
    if (/rock|paper|scissors|rps/.test(n.text)) return startGame('rps', mem);
    if (/guess|number/.test(n.text)) return startGame('guess', mem);
    if (YES.test(n.text)) { mem.expect = { kind: 'game' }; return 'Which one? Trivia, riddle, rock paper scissors, or guess the number?'; }
    if (NO.test(n.text)) return 'Okay! Maybe later. 🙂';
    return null;
  }
  if (e.kind === 'wyr') {
    if (n.words.length <= 12) return pick(['Interesting choice! 🤔 I’d have picked the same.', 'Bold. I respect it. 😎', 'Hmm, really? I’d go the other way! 😄']);
    return null;
  }
  return null;
}

// Smarter "I don't know": mention a nearby skill if a word hints at one.
function fallback(n, mem) {
  const hints = [
    [/\b(math|calculate|sum|add|multiply|divide)\b/, 'If it’s maths, try something like “what is 12 * 7” or “15% of 80”.'],
    [/\b(game|play|fun)\b/, 'Want to play? Say trivia, riddle, rock paper scissors, or guess the number.'],
    [/\b(time|date|day|month|year)\b/, 'For dates, try “what is the date” or “days until christmas”.'],
    [/\b(file|folder|directory)\b/, 'Try “what is in this folder”.'],
    [/\b(command|terminal|shell)\b/, 'Try “what is grep” or “explain ls -la”.'],
  ];
  const hint = hints.find(([re]) => re.test(n.text));
  if (hint) return `Hmm, I’m not sure what you mean. ${hint[1]}`;
  if (n.question) {
    const topic = n.words.filter((w) => !/^(what|who|where|when|why|how|is|are|the|a|an|do|does|can|you|i|of|to|in|it|that|this|about)$/.test(w)).slice(0, 3).join(' ');
    return topic ? `Good question about “${topic}” — but I don’t have a rule for it. I’m not a real AI. 🤷 Try “help” to see what I know.` : 'Good question! I don’t have a rule for that one. 🤷';
  }
  return fresh(mem, 'fallback', [
    'Hmm, I don’t have a rule for that. Try “help” to see what I can do. 🤖',
    'I’m not sure what you mean — but I’m great at jokes, games and maths!',
    'That’s beyond my if-statements. 😅 Ask me for a joke, a riddle, or the time?',
    'I’m going to pretend I understood that. 👍 (I didn’t.)',
  ]).item;
}

// The reply to one message.
function reply(input, shell, memory = {}) {
  const mem = memory;
  mem.turns = (mem.turns || 0) + 1;
  const n = normalize(input);
  if (!n.text) return '…you there? 👀';

  const record = (name, text) => { mem.last = { name, reply: text }; return text; };

  if (mem.game) {
    const r = playGame(n, mem);
    if (r !== null) return record('game', r);
    mem.game = null;
  }
  const expected = answerExpected(n, mem, shell);
  if (expected !== null) {
    return typeof expected === 'object' ? record(expected.name, expected.text) : record(mem.game ? 'game' : 'expected', expected);
  }

  if (!RULES) RULES = rules();
  for (const rule of RULES) {
    let m = null;
    if (rule.test instanceof RegExp) m = rule.test.exec(n.text);
    else {
      const v = rule.test(n, mem);
      if (v !== null && v !== undefined && v !== false) m = v;
    }
    if (!m) continue;
    const text = rule.run(m, n, mem, shell);
    if (text === null || text === undefined) continue;
    // "Another" after a follow-up keeps repeating the original kind.
    const name = rule.name === 'again' ? mem.last.name : rule.name;
    return record(name, text);
  }
  return record('fallback', fallback(n, mem));
}

const BYE = /^(bye|goodbye|good bye|bye bye|exit|quit|q|cya|see ya|see you|later|gotta go|i have to go|ttyl)[.!]*$/i;

// The chat loop, or one answer for `bot a question`.
function runBot(args, io, shell) {
  const t = theme.current();
  const R = ansi.reset();
  const botTag = `${ansi.fg(t.ui.accent)}${ansi.bold()}🤖 bot ❯${R}`;
  const youTag = `${ansi.fg(t.ui.accent2)}${ansi.bold()}you ❯${R} `;
  const say = (text) => shell.writeTo(io.stdout, `${botTag} ${text.split('\n').join('\n        ')}\n`);
  const memory = {};

  if (args.length) { say(reply(args.join(' '), shell, memory)); return 0; }

  say('Hi! I’m bot. 👋 Ask me things, play a game, or say “help”. Type bye to leave.');
  for (;;) {
    shell.writeTo(io.stdout, youTag);
    const line = shell.readLine(io.stdin);
    if (line === null) { shell.writeTo(io.stdout, '\n'); say('Bye! 👋'); return 0; }
    if (BYE.test(line.trim())) {
      say(pick([`Bye${memory.name ? ` ${memory.name}` : ''}! 👋`, 'See you later! 😊', 'Logging off. Beep boop. 🤖']));
      return 0;
    }
    say(reply(line, shell, memory));
  }
}

module.exports = { runBot, reply, rules, tryMaths, normalize, convert, parseDay, daysUntil };
