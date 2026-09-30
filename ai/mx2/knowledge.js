'use strict';

// Hand-written knowledge for mx2, in ai/mx2/knowledge/*.md:
//
//   ## Photosynthesis
//   aka: how plants make food, plant energy
//   Plants use sunlight, water and carbon dioxide to make sugar…
//   (more paragraphs)
//   Q: What gas do plants give off? | Oxygen — …
//
// Each article becomes chats: many ways to ask about the topic (answered
// with the article, or its first paragraph for quick questions), plus the
// specific Q/A pairs.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'knowledge');

function parseArticles() {
  const articles = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.md')).sort()) {
    const area = f.replace(/\.md$/, '');
    let cur = null;
    for (const raw of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const line = raw.trimEnd();
      const h = /^##\s+(.+)$/.exec(line);
      if (h) {
        cur = { area, title: h[1].trim(), aka: [], paras: [], qa: [] };
        articles.push(cur);
        continue;
      }
      if (!cur) continue;
      const aka = /^aka:\s*(.+)$/i.exec(line);
      if (aka) { cur.aka.push(...aka[1].split(',').map((s) => s.trim()).filter(Boolean)); continue; }
      const qa = /^Q:\s*(.+?)\s*\|\s*(.+)$/.exec(line);
      if (qa) { cur.qa.push([qa[1], qa[2]]); continue; }
      if (line.trim()) {
        if (cur.paras.length && !cur._gap) cur.paras[cur.paras.length - 1] += ` ${line.trim()}`;
        else cur.paras.push(line.trim());
        cur._gap = false;
      } else if (cur) cur._gap = true;
    }
  }
  for (const a of articles) delete a._gap;
  return articles;
}

// Topic names as people would say them: "Photosynthesis" → "photosynthesis",
// "The French Revolution" → "the French Revolution".
function topicNames(a) {
  const main = a.title.replace(/\s*\(.*\)$/, '');
  const lower = /^[A-Z][a-z]/.test(main) && !/^[A-Z][a-z]+ [A-Z]/.test(main) ? main.charAt(0).toLowerCase() + main.slice(1) : main;
  return [lower, ...a.aka];
}

const ASK = [
  (t) => `what is ${t}`, (t) => `what is ${t}?`, (t) => `tell me about ${t}`, (t) => `explain ${t}`,
  (t) => `can you explain ${t}?`, (t) => `what do you know about ${t}`, (t) => `${t}?`, (t) => `teach me about ${t}`,
  (t) => `i want to learn about ${t}`, (t) => `describe ${t}`, (t) => `give me a quick summary of ${t}`,
  (t) => `explain ${t} simply`, (t) => `explain ${t} like i'm 10`, (t) => `what's ${t}`,
];
const ASK_WHO = [(t) => `who was ${t}`, (t) => `who was ${t}?`, (t) => `tell me about ${t}`, (t) => `what did ${t} do`, (t) => `who is ${t}`];
const ASK_HOW = [(t) => `how does ${t} work`, (t) => `how does ${t} work?`, (t) => `explain how ${t} works`];

function articleChats(rand, { repeat = 6 } = {}) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chats = [];
  for (const a of parseArticles()) {
    const names = topicNames(a);
    const person = /^(person|people)$/.test(a.area) || /people/.test(a.area);
    const asks = person ? ASK_WHO : (/how/.test(a.title.toLowerCase()) ? ASK_HOW : ASK);
    const full = a.paras.join('\n\n');
    for (let i = 0; i < repeat; i++) {
      const t = pick(names);
      const q = pick(asks)(t);
      const short = /quick|summary|simply|like i'm 10/.test(q);
      chats.push([['user', q], ['ai', short || rand() < 0.3 ? a.paras[0] : full]]);
    }
    for (const [q, ans] of a.qa) {
      for (let i = 0; i < 3; i++) chats.push([['user', i === 0 ? q : rand() < 0.5 ? q.toLowerCase() : q.replace(/\?$/, '')], ['ai', ans]]);
    }
    // A follow-up: tell me more.
    if (a.paras.length > 1) {
      chats.push([['user', pick(asks)(pick(names))], ['ai', a.paras[0]], ['user', pick(['tell me more', 'more please', 'go on', 'what else?', 'interesting, tell me more'])], ['ai', a.paras.slice(1).join('\n\n')]]);
    }
  }
  return chats;
}

module.exports = { parseArticles, articleChats, topicNames };

if (require.main === module) {
  const arts = parseArticles();
  const words = arts.reduce((n, a) => n + a.paras.join(' ').split(/\s+/).length + a.qa.reduce((m, [q, x]) => m + q.split(' ').length + x.split(' ').length, 0), 0);
  const byArea = {};
  for (const a of arts) byArea[a.area] = (byArea[a.area] || 0) + 1;
  console.log(`${arts.length} articles, ${words.toLocaleString()} words, ${arts.reduce((n, a) => n + a.qa.length, 0)} Q/A pairs`);
  console.log(Object.entries(byArea).map(([k, v]) => `${k} ${v}`).join(' · '));
}
