'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');

// `bot`: a chat "AI" that is really a list of if/else rules, checked in
// order — keywords and regular expressions, first match answers. No AI API,
// no network: fake on purpose, and it says so if you ask.

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs. 🐛',
  'There are 10 kinds of people: those who understand binary and those who don’t.',
  'I would tell you a UDP joke, but you might not get it.',
  'A SQL query walks into a bar, walks up to two tables and asks: “Can I join you?”',
  'Why did the shell script break up with the terminal? Too many issues with commitment… I mean, exit codes.',
  '!false — it’s funny because it’s true.',
  'How many programmers does it take to change a light bulb? None, that’s a hardware problem.',
];

const FALLBACK = [
  'Hmm, I don’t have a rule for that. I’m only a bunch of if-statements. 🤖',
  'No idea, honestly. Try asking me for a joke, the time, some maths, or “help”.',
  'That one’s beyond my rules. Ask “what can you do” to see what I know.',
  'I’m going to pretend I understood that. 👍 (I didn’t.)',
];

// How to do things in maxshell: [pattern, answer].
const HOWTO = [
  [/\bundo\b/, 'At the prompt, Ctrl-Z undoes your last edit (Ctrl-_ too). While a command runs, Ctrl-Z suspends it instead.'],
  [/\b(suspend|pause|background|jobs?|fg|bg)\b/, 'Ctrl-Z pauses what’s running, `jobs` lists paused and background jobs, `fg` brings one back, `bg` keeps it going in the background, and `cmd &` starts one there.'],
  [/\bpalette|do anything|ctrl-?p\b/, 'Ctrl-P opens the command palette: tools, scripts, git actions, themes, bookmarks and recent commands, all searchable.'],
  [/\b(explain|what does .* do|alt-?h)\b/, 'Type a command and press Alt-H — or run `explain \'the command\'` — and I… well, maxshell… takes it apart piece by piece.'],
  [/\b(ram|memory|cpu|slow|clean ?up|speed)\b/, '`cleanup` quits what isn’t needed; `cleanup -r` then helps free memory and `cleanup -c` the CPU. `cleanup -n` just shows what it would do.'],
  [/\b(theme|colou?rs?)\b/, '`theme` lists the colour themes with previews; `theme nord` (or any name) switches and remembers it.'],
  [/\b(history|search|ctrl-?r|find .*command)\b/, 'Ctrl-R searches every command you’ve run — type any words, in any order.'],
  [/\b(snippets?|save .*command|alt-?s)\b/, 'Alt-S saves the line you’re typing as a snippet; `snip` brings one back.'],
  [/\b(bookmarks?|mark|go to .*folder)\b/, '`mark` bookmarks this folder, `go` jumps back to a bookmark.'],
  [/\b(jump|frequent|cd faster|j\b)/, '`j words` jumps to the folder you use most that matches, e.g. `j max` → ~/maxshell. `back` and `forward` walk your folder history.'],
  [/\b(edit|editor|nano|vim)\b/, '`edit file` opens maxshell’s editor: ^O saves, ^X exits, ^G shows help.'],
  [/\b(files?|finder|browse)\b/, '`files` opens a Finder-style browser: arrows to move, Enter to open, q to leave in that folder.'],
  [/\b(git|commit|stage|push)\b/, '`gitui` stages, diffs, commits and pushes; `G` inside it opens the GitHub screen.'],
  [/\b(dashboard|dash|overview)\b/, '`dash` shows git, jobs, CPU, memory and recent commands on one live screen.'],
  [/\b(default shell|chsh|login shell)\b/, '`maxshell --make-default` makes maxshell your default shell. To go back: `chsh -s /bin/zsh`.'],
  [/\b(rc|config|startup|aliases?)\b/, 'Put aliases and settings in ~/.maxshellrc — maxshell runs it at startup. `edit ~/.maxshellrc` to start one.'],
  [/\b(brainrot|6-?7)\b/, 'Run `6-7`. You’ve been warned. 💀'],
];

// Safe arithmetic: digits, operators and brackets only.
function tryMaths(text) {
  const expr = text
    .replace(/\btimes\b|×|x(?=\s*\d)/gi, '*').replace(/\bdivided by\b|÷/gi, '/')
    .replace(/\bplus\b/gi, '+').replace(/\bminus\b/gi, '-').replace(/\bto the power of\b|\^/gi, '**')
    .replace(/\bsquared\b/gi, '**2').replace(/[?=]/g, '')
    .replace(/^.*?(?=[-(\d.])/, '').trim();
  if (!expr || !/^[\d\s+\-*/%().]+$/.test(expr) || !/\d/.test(expr) || !/[+\-*/%]/.test(expr)) return null;
  try {
    const { evalValue, formatValue } = require('./arith');
    const v = evalValue(expr.replace(/(\d)\.(?!\d)/g, '$1'), null);
    return formatValue(v).replace(/\.$/, '');
  } catch (e) {
    return /division by zero/.test(e.message) ? 'division by zero — even I know not to do that' : null;
  }
}

// The rules, in order. Each has `test` (a RegExp, or a function of the
// lower-cased text) and `reply` (text, or a function of the match and the
// chat's memory).
function rules() {
  return [
    { test: /^(hi|hello|hey|yo|sup|hiya|howdy|good (morning|afternoon|evening))\b/, reply: (m, mem) => pick([`Hey${mem.name ? ` ${mem.name}` : ''}! 👋`, 'Hello, human.', 'Yo! What’s up?', 'Hi there! Ask me anything (within reason and within my rules).']) },
    { test: /\b(my name is|call me) ([a-z][\w-]*)[.!]?$/, reply: (m, mem) => { mem.name = cap(m[2]); return `Nice to meet you, ${mem.name}! I’ll remember that (until you close me).`; } },
    { test: /\bwhat('?s| is) my name\b/, reply: (m, mem) => (mem.name ? `You’re ${mem.name}. Unless you lied to me. 🤨` : 'You haven’t told me! Say “my name is …”.') },
    { test: /\b(are you (an? )?(real )?ai|are you real|are you (chat)?gpt|are you claude|do you (use|call) (an )?ai|how do you work)\b/, reply: 'Honestly? No. I’m a big list of if/else rules in src/bot.js — no AI, no internet. Fake on purpose. 🤖' },
    { test: /\b(who|what) are you\b|\byour name\b/, reply: 'I’m bot, maxshell’s built-in chat buddy. Powered by approximately zero neural networks.' },
    { test: /\bwho (made|built|created|wrote) (you|maxshell)\b/, reply: 'maxshell — and me — were built by Max. From scratch, in Node.js.' },
    { test: /\bhow are you\b|\bhow('?s| is) it going\b|\bwhat'?s up\b/, reply: () => pick(['Running at 100% if-statement efficiency. You?', 'Great! Nothing crashed yet today.', 'Can’t complain. Literally — there’s no rule for complaining.']) },
    { test: /\b(what time|the time|time is it)\b/, reply: () => `It’s ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ⏰` },
    { test: /\b(what('?s| is) the date|what day|today'?s date|what is today)\b/, reply: () => `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. 📅` },
    { test: /\b(weather|temperature|forecast|rain)\b/, reply: 'I can’t check the weather — I don’t use the internet. Try looking out of a window. 🪟' },
    { test: /\b(news|google|search the web|look up)\b/, reply: 'No internet for me, I’m afraid. I only know what my rules know.' },
    { test: /\b(joke|funny|make me laugh)\b/, reply: () => pick(JOKES) },
    { test: /\b(6-?7|six seven)\b/, reply: '🤷 6️⃣7️⃣ 🤷' },
    { test: (t) => tryMaths(t), reply: (v) => `That’s ${v}. 🧮` },
    { test: /\b(explain|what does) [`'"]?(.+?)[`'"]?( do| mean)?\??$/, reply: (m, mem, shell) => explainLine(m[2], shell) },
    { test: /\b(what('?s| is) in (this|the) folder|what files|list files|where am i)\b/, reply: (m, mem, shell) => folderSummary(shell) },
    { test: /\b(git status|what('?s| has) changed|which branch|what branch)\b/, reply: (m, mem, shell) => gitSummary(shell) },
    { test: /\b(roll|dice|d6)\b/, reply: () => `🎲 You rolled a ${1 + Math.floor(Math.random() * 6)}.` },
    { test: /\b(flip|coin|heads or tails)\b/, reply: () => `🪙 ${pick(['Heads', 'Tails'])}!` },
    { test: /\b(pick|choose) (between |from )?(.+) or (.+)$/, reply: (m) => `I pick… ${pick([m[3], m[4]]).replace(/[?.!]$/, '')}. Final answer.` },
    { test: /\b(meaning of life|42)\b/, reply: '42. Obviously.' },
    { test: /\b(i love you|you('?re| are) (great|awesome|cool|the best))\b/, reply: 'Aww. 🥹 My rules are blushing.' },
    { test: /\b(you('?re| are) (dumb|stupid|useless|bad)|i hate you)\b/, reply: 'Fair. I am, after all, just a pile of if-statements. 🫠' },
    { test: /\b(thanks|thank you|thx|ty)\b/, reply: () => pick(['You’re welcome! 😊', 'Any time.', 'No problem!']) },
    { test: /\b(what can you do|help|commands|what do you know)\b/, reply: 'I can chat a bit, tell the time and date, do maths (“what is 12 * 7”), tell jokes, roll dice, flip coins, pick between things, explain a command (“explain tar -xzf a.tgz”), say what’s in this folder or how git looks, and answer “how do I …” about maxshell (undo, jobs, palette, cleanup, themes…). Type bye to leave.' },
    { test: /\b(how (do|can) i|how to|where is|what is the (key|shortcut))\b/, reply: (m, mem, shell, text) => howTo(text) },
    { test: (t) => HOWTO.find(([re]) => re.test(t)), reply: (hit) => hit[1] },
    { test: /\?$/, reply: () => pick(['Good question. I have no rule for it. 🤷', 'I wish I knew!', 'Ask Max to write a rule for that.']) },
  ];
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function howTo(text) {
  const hit = HOWTO.find(([re]) => re.test(text));
  return hit ? hit[1] : 'I don’t have a “how to” for that. Try asking about undo, jobs, the palette, cleanup, themes, snippets, bookmarks, git or the editor.';
}

function explainLine(line, shell) {
  const { explainRows } = require('./explain');
  const rows = explainRows(line, shell).filter((r) => r[0].trim());
  if (!rows.length) return 'Nothing to explain there.';
  return `Here’s what \`${line}\` does:\n${rows.map(([term, what]) => `   ${term.padEnd(14)} ${what}`).join('\n')}`;
}

function folderSummary(shell) {
  let names = [];
  try { names = fs.readdirSync(shell.cwd).filter((n) => !n.startsWith('.')); } catch { /* unreadable */ }
  const dirs = names.filter((n) => { try { return fs.statSync(path.join(shell.cwd, n)).isDirectory(); } catch { return false; } });
  const home = require('os').homedir();
  const where = shell.cwd.startsWith(home) ? `~${shell.cwd.slice(home.length)}` : shell.cwd;
  if (!names.length) return `You’re in ${where}, and it’s empty. 🫙`;
  const sample = names.slice(0, 6).join(', ');
  return `You’re in ${where}: ${dirs.length} folder${dirs.length === 1 ? '' : 's'} and ${names.length - dirs.length} file${names.length - dirs.length === 1 ? '' : 's'} (${sample}${names.length > 6 ? ', …' : ''}).`;
}

function gitSummary(shell) {
  const r = spawnSync('git', ['status', '--porcelain', '--branch'], { cwd: shell.cwd, encoding: 'utf8', timeout: 2000 });
  if (r.status !== 0) return 'This folder isn’t a git repository.';
  const lines = r.stdout.split('\n').filter(Boolean);
  const branch = (/^## ([^.\s]+)/.exec(lines[0] || '') || [])[1] || '?';
  const changes = lines.length - 1;
  return changes ? `You’re on ${branch} with ${changes} changed file${changes === 1 ? '' : 's'}. \`gitui\` to look at them.` : `You’re on ${branch} and everything is committed. ✨`;
}

// The reply to one message: the first rule that matches wins.
function reply(input, shell, memory = {}) {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return '…you there? 👀';
  for (const rule of rules()) {
    let m = null;
    if (rule.test instanceof RegExp) m = rule.test.exec(text);
    else {
      const v = rule.test(text);
      if (v !== null && v !== undefined && v !== false) m = v;
    }
    if (!m) continue;
    return typeof rule.reply === 'function' ? rule.reply(m, memory, shell, text) : rule.reply;
  }
  return pick(FALLBACK);
}

const BYE = /^(bye|goodbye|exit|quit|q|cya|see ya|later)[.!]*$/i;

// The chat loop, or one answer for `bot a question`.
function runBot(args, io, shell) {
  const t = theme.current();
  const R = ansi.reset();
  const botTag = `${ansi.fg(t.ui.accent)}${ansi.bold()}🤖 bot ❯${R}`;
  const youTag = `${ansi.fg(t.ui.accent2)}${ansi.bold()}you ❯${R} `;
  const say = (text) => shell.writeTo(io.stdout, `${botTag} ${text.split('\n').join('\n        ')}\n`);
  const memory = {};

  if (args.length) { say(reply(args.join(' '), shell, memory)); return 0; }

  say('Hi! I’m bot. Ask me things — or “help”. Type bye to leave.');
  for (;;) {
    shell.writeTo(io.stdout, youTag);
    const line = shell.readLine(io.stdin);
    if (line === null) { shell.writeTo(io.stdout, '\n'); say('Bye! 👋'); return 0; }
    if (BYE.test(line.trim())) { say(pick(['Bye! 👋', 'See you later!', 'Logging off. Beep boop. 🤖'])); return 0; }
    say(reply(line, shell, memory));
  }
}

module.exports = { runBot, reply, rules, tryMaths };
