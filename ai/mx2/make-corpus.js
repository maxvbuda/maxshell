#!/usr/bin/env node
'use strict';

// Builds mx2's training data from what's written in ai/mx2/ (all validated)
// plus mx's chat dataset. Output: ai/mx2/data/chat.jsonl, one conversation
// per line: {"sys": "...", "turns": [["user", "..."], ["ai", "..."], ...]}.
//
//   node ai/mx2/make-corpus.js [--sites N] [--repeat N]

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, 'data');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };

let seed = 2026;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
Math.random = rand;
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;

const LANG_NAMES = {
  python: 'Python', javascript: 'JavaScript', c: 'C', cpp: 'C++', bash: 'bash', sql: 'SQL', html: 'HTML',
  css: 'CSS', swift: 'Swift', ruby: 'Ruby', perl: 'Perl', java: 'Java', go: 'Go', rust: 'Rust', typescript: 'TypeScript',
};
const FENCE = { javascript: 'javascript', python: 'python', c: 'c', cpp: 'cpp', bash: 'bash', sql: 'sql', html: 'html', css: 'css', swift: 'swift', ruby: 'ruby', perl: 'perl', java: 'java', go: 'go', rust: 'rust', typescript: 'typescript' };

// Casual variations of a request.
function vary(text) {
  let t = text;
  if (chance(0.2)) t = pick(['hey, ', 'can you ', 'please ', 'quick question: ', 'i need help: ', 'hi! ']) + t;
  if (chance(0.3)) t = t.replace(/[?.!]+$/, '');
  if (chance(0.5)) t = t.toLowerCase();
  else t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.replace(/\s+/g, ' ').trim();
}

const out = [];
const sys = () => 'date: Tuesday, September 29, 2026 · time: 10:15 AM';
function emit(turns) { out.push({ sys: sys(), turns }); }

function answerFor(lang, impl, task) {
  const intro = pick([
    '',
    `Here’s how to ${task} in ${LANG_NAMES[lang]}:\n\n`,
    `Sure! In ${LANG_NAMES[lang]}:\n\n`,
    `Here you go:\n\n`,
    `This does it:\n\n`,
  ]);
  const code = `\`\`\`${FENCE[lang] || ''}\n${impl.code}\n\`\`\``;
  const outBlock = impl.run && impl.run.out && chance(0.4) && impl.run.out.length < 300 ? `\n\nOutput:\n\n\`\`\`\n${impl.run.out.replace(/\n$/, '')}\n\`\`\`` : '';
  return `${intro}${code}${outBlock}\n\n${impl.explain}`;
}

// --- code entries -------------------------------------------------------------

function codeChats(repeat, skip = new Set()) {
  const dir = path.join(HERE, 'code');
  let entries = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) entries = entries.concat(require(path.join(dir, f)));
  entries = entries.filter((e) => !skip.has(e.task)); // held out for an exam
  for (let r = 0; r < repeat; r++) {
    for (const e of entries) {
      const langs = Object.keys(e.impls);
      for (const lang of langs) {
        const impl = e.impls[lang];
        // Half the time, a generic wording made from the task, so every task
        // is asked for in many ways (not just its hand-written ones).
        let ask = chance(0.5) ? pick(require('./exercise-kit').asksFor(e.task)) : pick(e.asks);
        if (ask.includes('{lang}')) ask = ask.replace('{lang}', LANG_NAMES[lang].toLowerCase());
        else if (langs.length > 1 || chance(0.3)) ask += pick([` in ${LANG_NAMES[lang]}`, ` using ${LANG_NAMES[lang]}`, ` (${LANG_NAMES[lang].toLowerCase()})`]);
        if (impl.broken) {
          // Debugging: the person pastes the broken code.
          const q = `${vary(ask)}\n\n\`\`\`${FENCE[lang] || ''}\n${impl.broken}\n\`\`\``;
          const a = `${pick(['The problem: ', '', 'Found it — ', 'Here’s what’s going on: '])}${impl.explain}\n\nFixed:\n\n\`\`\`${FENCE[lang] || ''}\n${impl.code}\n\`\`\``;
          emit([['user', q], ['ai', a]]);
          continue;
        }
        const turns = [['user', vary(ask)], ['ai', answerFor(lang, impl, e.task)]];
        // Follow-ups in another language, or a question about it.
        const others = langs.filter((l) => l !== lang);
        if (others.length && chance(0.5)) {
          const other = pick(others);
          turns.push(['user', vary(pick([`now do it in ${LANG_NAMES[other]}`, `can you show it in ${LANG_NAMES[other]}?`, `what about ${LANG_NAMES[other]}`, `same thing in ${LANG_NAMES[other]} please`]))]);
          turns.push(['ai', answerFor(other, e.impls[other], e.task)]);
        } else if (chance(0.25)) {
          turns.push(['user', vary(pick(['how does it work?', 'can you explain that', 'explain the code', 'why does that work?']))]);
          turns.push(['ai', impl.explain]);
        }
        emit(turns);
      }
    }
  }
}

// --- websites ------------------------------------------------------------------------

function siteChats(n) {
  const { siteConversation, buildSite, PALETTES } = require('./sitegen');
  for (let i = 0; i < n; i++) {
    const c = siteConversation(rand);
    const turns = [['user', vary(c.request)], ['ai', c.reply]];
    // Follow-up edits answered with just the change.
    if (chance(0.45)) {
      const palette = pick(PALETTES.filter((p) => p.name !== c.spec.palette));
      const edits = [
        [`change the main colour to ${palette.name}`, `Change the two colour variables at the top of the \`<style>\`:\n\n\`\`\`css\n:root {\n  --primary: ${palette.primary};\n  --primary-dark: ${palette.dark};\n}\n\`\`\`\n\nEverything that uses \`var(--primary)\` — the logo, buttons and prices — updates at once.`],
        ['make the buttons fully round', 'Set the radius variable to a large value:\n\n```css\n:root {\n  --radius: 999px;\n}\n```\n\nThat rounds the buttons, cards and form fields. To round only the buttons, add `.btn { border-radius: 999px; }` instead.'],
        ['how do i put it online', 'The easiest free options: drag the `index.html` file onto Netlify Drop (app.netlify.com/drop), or push it to a GitHub repository and turn on GitHub Pages in the repo’s settings. Either gives you a public link in a minute.'],
        ['add a favicon', 'Add this line inside the `<head>`, with an image called `favicon.png` next to your HTML file:\n\n```html\n<link rel="icon" href="favicon.png">\n```\n\nOr use an emoji with no image file at all:\n\n```html\n<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌟</text></svg>">\n```'],
        ['make the heading bigger', 'Increase the hero heading size:\n\n```css\n.hero h1 {\n  font-size: 4rem;\n}\n```\n\nKeep the smaller size in the `@media (max-width: 720px)` block so it still fits on phones.'],
        ['use a google font', 'Add the font link in the `<head>`, then use it in `body`:\n\n```html\n<link rel="preconnect" href="https://fonts.googleapis.com">\n<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap" rel="stylesheet">\n```\n\n```css\nbody {\n  font-family: \'Poppins\', sans-serif;\n}\n```'],
      ];
      if (!c.spec.dark) edits.push(['make it dark mode', 'Swap the colour variables for dark ones:\n\n```css\n:root {\n  --bg: #0f172a;\n  --soft: #111c33;\n  --card: #1e293b;\n  --text: #e2e8f0;\n  --muted: #94a3b8;\n}\n```\n\nThe whole page follows, because every colour in the stylesheet comes from these variables.']);
      const [q, a] = pick(edits);
      turns.push(['user', vary(q)], ['ai', a]);
    }
    emit(turns);
  }
  return buildSite;
}

// --- mx's existing chats (how-tos, maxshell, knowledge, small talk) --------------------

function mxChats(limit) {
  const file = path.join(HERE, '..', 'data', 'dataset.jsonl');
  if (!fs.existsSync(file)) { process.stderr.write('  (no ai/data/dataset.jsonl — run node ai/make-dataset.js)\n'); return; }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (let i = 0; i < Math.min(limit, lines.length); i++) {
    const c = JSON.parse(lines[i]);
    // mx2 introduces itself as mx2.
    c.turns = c.turns.map(([who, t]) => [who, who === 'ai' ? t.replace(/about 15 million (numbers|parameters)/g, 'about 60 million $1').replace(/\bI’m mx\b/g, 'I’m mx') : t]);
    out.push(c);
  }
}

// --- knowledge articles, written by hand -----------------------------------------------

function knowledgeChats() {
  const dir = path.join(HERE, 'knowledge');
  if (!fs.existsSync(dir)) return;
  const { articleChats } = require('./knowledge');
  for (const c of articleChats(rand)) emit(c);
}

// --- go ------------------------------------------------------------------------------------

// ai/mx3/make-corpus.js reuses the builders; they push into `out`.
module.exports = { out, codeChats, siteChats, knowledgeChats, vary, rand, pick, chance };
if (require.main === module) main();

function main() {
const steps = [
  ['code', () => codeChats(argOf('--repeat', 30))],
  ['websites', () => siteChats(argOf('--sites', 20000))],
  ['knowledge', () => knowledgeChats()],
  ['mx chats', () => mxChats(argOf('--mx', 120000))],
];
for (const [label, fn] of steps) {
  const before = out.length;
  fn();
  process.stderr.write(`  ${label.padEnd(12)} ${out.length - before}\n`);
}
for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, 'chat.jsonl');
fs.writeFileSync(file, `${out.map((c) => JSON.stringify(c)).join('\n')}\n`);
process.stderr.write(`wrote ${out.length} conversations, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB → ${path.relative(path.join(HERE, '..', '..'), file)}\n`);
}
