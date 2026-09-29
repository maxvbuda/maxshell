'use strict';

// `6-7`: brainrot mode, for this session. The prompt, the ✓/✗ lines and
// "command not found" all get the treatment, a loud theme goes on, and any
// command with a 67 in it gets a reaction. `6-7` again (or `6-7 off`) brings
// everything back, your theme included.

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const WINS = ['W', 'massive W', 'W rizz', 'goated', 'no cap that worked', 'bussin', 'aura +1000', 'cooked (in a good way)'];
const LOSSES = ['L', 'skill issue', 'down bad', 'cooked', 'aura −500', 'it’s giving error', 'not the vibe', 'ratio’d by the computer'];
const SLOW = ['took forever fr', 'waiting like a sigma', 'mid speed', 'loading era'];
const WHO = ['who is bro', 'never heard of her', 'that’s not a thing chat', 'bro made that up', 'lowkey doesn’t exist'];
const HELLO = [
  'brainrot mode ON — no cap',
  'we are so back',
  'chat is this real',
  'the shell is now skibidi certified',
  'sigma terminal unlocked',
];

// The two big digits, drawn in block characters.
const SIX_SEVEN = [
  '  ██████   ███████',
  '  ██            ██ ',
  '  ██████       ██  ',
  '  ██  ██      ██   ',
  '  ██████     ██    ',
];

function statusLine(status, ms, formatDuration) {
  if (status === 127) return null;
  if (status === 130) return { ok: false, text: '✗ bro rage quit 😭' };
  const took = ms >= 1000 ? ` · ${formatDuration(ms)}${ms >= 10000 ? ` (${pick(SLOW)})` : ''}` : '';
  if (status !== 0) return { ok: false, text: `✗ ${pick(LOSSES)} 💀 exit ${status}${took}` };
  if (ms >= 1000) return { ok: true, text: `✓ ${pick(WINS)} 🔥${took}` };
  return null;
}

function notFound(name, guess) {
  return `maxshell: ${name}?? ${pick(WHO)} 💀${guess ? ` — you meant ${guess}, no cap` : ' — skill issue'}\n`;
}

// Does this command line have a 67 in it?
function mentions67(line) {
  return /(^|[^\d])6\s*[-,.]?\s*7([^\d]|$)/.test(line) && !/^\s*6-7(\s|$)/.test(line);
}

function reaction() {
  return pick(['🤷 6️⃣7️⃣ 🤷', '6… 7 🤷‍♂️', 'SIX SEVEN 🗣️🔥', '67?? 🤷 🤷']);
}

// Turns the mode on or off; returns what to print.
function toggle(shell, arg) {
  const theme = require('./theme');
  const ansi = require('./ansi');
  const turnOn = arg === 'on' ? true : arg === 'off' ? false : !shell.brainrot;
  if (turnOn === !!shell.brainrot) return shell.brainrot ? 'already brainrotted 💀\n' : 'already normal. boring. 😐\n';
  if (turnOn) {
    shell.brainrot = { theme: theme.currentThemeName() };
    // A loud theme for the session only; your saved one isn't touched.
    theme.setTheme(theme.THEMES.dracula ? 'dracula' : theme.currentThemeName());
    const g = theme.current().gradient || [];
    const art = SIX_SEVEN.map((l, i) => `${ansi.fg(g[i % Math.max(1, g.length)] ?? 207)}${l}${ansi.reset()}`).join('\n');
    return `\n${art}\n\n  🤷  ${pick(HELLO)}  🤷\n  ${ansi.fg('gray')}6-7 again to go back to normal${ansi.reset()}\n\n`;
  }
  theme.setTheme(shell.brainrot.theme);
  shell.brainrot = null;
  return 'brainrot mode off. touching grass now 🌱\n';
}

module.exports = { toggle, statusLine, notFound, mentions67, reaction, SIX_SEVEN };
