'use strict';

// Game conversations for mx4: a request in one of many wordings, and a reply
// with a short intro, the complete game in one HTML file, and notes on how
// to play, how it works and what to change. Plus follow-ups that change a
// game ("make it faster"), answered with the change.
//
//   node ai/mx4/gamegen.js [n]   plays n generated games of every kind

const { BUILDERS, THEMES, FONTS } = require('./games-web');

const KINDS = {
  snake: { names: ['snake', 'a snake game', 'the snake game', 'snake (the classic phone game)'], titles: ['Snake', 'Snake Game', 'Neon Snake', 'Hungry Snake', 'Slither'] },
  pong: { names: ['pong', 'a pong game', 'ping pong', 'a paddle and ball game like pong'], titles: ['Pong', 'Paddle Battle', 'Retro Pong', 'Ping Pong'] },
  breakout: { names: ['breakout', 'a brick breaker game', 'brick breaker', 'a breakout game', 'arkanoid'], titles: ['Breakout', 'Brick Breaker', 'Brick Smash', 'Block Buster'] },
  flappy: { names: ['flappy bird', 'a flappy bird game', 'a flappy bird clone', 'a game where you flap through pipes'], titles: ['Flappy', 'Flappy Bird', 'Flappy Flight', 'Flap!'] },
  tictactoe: { names: ['tic tac toe', 'tic-tac-toe', 'noughts and crosses', 'a tic tac toe game'], titles: ['Tic-Tac-Toe', 'Tic Tac Toe', 'Noughts & Crosses', 'Three in a Row'] },
  memory: { names: ['a memory game', 'a card matching game', 'memory match', 'a memory card game', 'a game where you match pairs'], titles: ['Memory Match', 'Match the Pairs', 'Memory', 'Flip & Match'] },
  whack: { names: ['whack a mole', 'whack-a-mole', 'a whack a mole game', 'a game where you click things that pop up'], titles: ['Whack-a-Mole', 'Whack It!', 'Bonk!', 'Pop & Whack'] },
  shooter: { names: ['a space shooter', 'a space invaders game', 'a shooting game', 'a space game where you shoot aliens', 'a shoot em up'], titles: ['Space Shooter', 'Star Defender', 'Galaxy Blaster', 'Alien Attack'] },
  catcher: { names: ['a catching game', 'a game where you catch falling things', 'catch the falling fruit', 'a falling objects game'], titles: ['Catch!', 'Fruit Catcher', 'Falling Stars', 'Treasure Rain'] },
  guess: { names: ['a number guessing game', 'guess the number', 'a guessing game', 'a higher or lower game'], titles: ['Guess the Number', 'Number Guesser', 'Higher or Lower', 'Mystery Number'] },
  rps: { names: ['rock paper scissors', 'a rock paper scissors game', 'rps', 'rock, paper, scissors against the computer'], titles: ['Rock Paper Scissors', 'Rock, Paper, Scissors!', 'RPS Showdown'] },
  clicker: { names: ['a clicker game', 'a cookie clicker game', 'an idle clicker game', 'an incremental game'], titles: ['Cookie Clicker', 'Click Empire', 'Idle Clicker', 'Gem Clicker'] },
  reaction: { names: ['a reaction time game', 'a reaction test', 'a reflex game', 'a game that tests how fast i can click'], titles: ['Reaction Test', 'How Fast Are You?', 'Reflexes', 'Quick Click'] },
};

const ASKS = [
  (g) => `make ${g}`, (g) => `make me ${g}`, (g) => `can you make ${g}?`, (g) => `code ${g} in javascript`,
  (g) => `write ${g} in html and javascript`, (g) => `build ${g} i can play in my browser`, (g) => `i want to make ${g}`,
  (g) => `how do i make ${g}?`, (g) => `create ${g}`, (g) => `make a simple version of ${g}`, (g) => `can you code ${g} for me`,
  (g) => `write the code for ${g}`, (g) => `make ${g} with html css and js`, (g) => `please make ${g}`, (g) => `let's make ${g}`,
  (g) => `show me how to code ${g}`, (g) => `i need ${g} for a school project`, (g) => `build ${g} in one html file`,
];
const GENERIC = ['make a game', 'make a simple game', 'make me a game', 'can you make a game?', 'code a game', 'make a fun game i can play',
  'write a small browser game', 'make a game in javascript', 'can you code a simple game?', 'build me a game', 'make a game for my website'];
const INTROS = [
  (title) => `Here’s ${title} — a complete game in one file. Save it as \`index.html\` and open it in your browser.`,
  (title) => `Sure! This is ${title}, all in a single HTML file (HTML, CSS and JavaScript together). Save it as \`game.html\` and double-click it to play.`,
  (title) => `Here you go — ${title}. Copy it into a file called \`index.html\` and open it in any browser.`,
  (title) => `Let’s build ${title}! Everything is in one file, so you can save it as \`index.html\` and play right away.`,
];

const an = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

function rng(rand) {
  return { pick: (list) => list[Math.floor(rand() * list.length)], chance: (p) => rand() < p, rand };
}

function gameConversation(rand, kind = null) {
  const r = rng(rand);
  const k = kind || r.pick(Object.keys(KINDS));
  const meta = KINDS[k];
  const t = r.pick(THEMES);
  const named = r.chance(0.3);
  const title = named ? r.pick(['Max’s', 'Super', 'Mega', 'Tiny', 'Cosmic', 'Pixel', 'Turbo']) + ' ' + r.pick(meta.titles) : r.pick(meta.titles);
  const spec = { t, font: r.pick(FONTS), title };
  const { html, notes } = BUILDERS[k](spec, r);
  let request;
  if (r.chance(0.08)) request = r.pick(GENERIC);
  else {
    request = r.pick(ASKS)(r.pick(meta.names));
    if (named) request += ` called ${title}`;
    if (r.chance(0.25)) request += r.pick([` with ${an(t.name)} theme`, ` in ${t.name} colours`, ` that looks ${t.name}`]);
  }
  const reply = `${r.pick(INTROS)(title)}\n\n\`\`\`html\n${html}\n\`\`\`\n\n${notes.join('\n\n')}`;
  return { kind: k, title, request, reply, html, spec };
}

// Follow-ups that change a game, answered with just the change.
const FOLLOW_UPS = {
  snake: [['make it faster', 'Lower `START_SPEED` near the top — it’s the milliseconds between moves, so smaller is faster:\n\n```javascript\nconst START_SPEED = 70;\n```'],
    ['make the snake a different colour', 'The colours are set in `draw()`. Change the body colour (the `i === 0` one is the head):\n\n```javascript\nctx.fillStyle = i === 0 ? \'#ffffff\' : \'#f97316\';\n```']],
  pong: [['make the computer harder', 'Raise `AI_SPEED` — it’s how many pixels the computer’s paddle can move each frame:\n\n```javascript\nconst AI_SPEED = 7;\n```\n\nAt 7 or more it almost never misses.'],
    ['make the paddles bigger', 'Change `PADDLE_H` near the top:\n\n```javascript\nconst PADDLE_H = 120;\n```']],
  breakout: [['add more rows of bricks', 'Raise `ROWS` near the top — the bricks are built from it in `reset()`:\n\n```javascript\nconst ROWS = 7;\n```'],
    ['give me more lives', 'In `reset()`, change the starting lives:\n\n```javascript\nlives = 5;\n```']],
  flappy: [['make it easier', 'Make the gap bigger and gravity weaker:\n\n```javascript\nconst GRAVITY = 0.35;\nconst GAP = 190;\n```'],
    ['make it a rocket instead', 'Change the emoji drawn in `draw()`:\n\n```javascript\nctx.fillText(\'🚀\', player.x, player.y);\n```']],
  memory: [['add more cards', 'Add more emoji to `SYMBOLS` (each one becomes a pair), and widen the grid in the CSS so they fit:\n\n```css\n#grid { grid-template-columns: repeat(5, 80px); }\n```']],
  whack: [['make the game longer', 'Change `GAME_SECONDS` at the top:\n\n```javascript\nconst GAME_SECONDS = 60;\n```']],
  shooter: [['make enemies come faster', 'Lower `SPAWN_EVERY` — it’s the number of frames between enemies:\n\n```javascript\nconst SPAWN_EVERY = 25;\n```'],
    ['let me shoot faster', 'In `update()`, lower the cooldown set after each shot:\n\n```javascript\ncooldown = 6;\n```']],
  guess: [['make the range 1 to 1000', 'Change `MAX`:\n\n```javascript\nconst MAX = 1000;\n```\n\nAnd the `max` attribute on the input: `<input id="guess" type="number" min="1" max="1000">`.']],
  any: [['how do i put it online', 'Drag the HTML file onto Netlify Drop (app.netlify.com/drop) for a public link in seconds, or push it to a GitHub repository and turn on GitHub Pages in its settings.'],
    ['add a sound when you score', 'Add this function and call `beep()` wherever the score goes up:\n\n```javascript\nconst audio = new AudioContext();\n\nfunction beep(frequency = 660) {\n  const osc = audio.createOscillator();\n  const gain = audio.createGain();\n  osc.frequency.value = frequency;\n  gain.gain.value = 0.1;\n  osc.connect(gain).connect(audio.destination);\n  osc.start();\n  osc.stop(audio.currentTime + 0.1);\n}\n```\n\n(Browsers only allow sound after you’ve clicked or pressed a key on the page.)'],
    ['how does requestAnimationFrame work', '`requestAnimationFrame(fn)` asks the browser to call `fn` just before it next draws the screen — about 60 times a second. Calling it again at the end of your `loop()` keeps the game running, and it pauses automatically when the tab is hidden, which saves battery.'],
    ['save the high score', 'Use `localStorage`, which keeps small values in the browser even after a reload:\n\n```javascript\nlet best = Number(localStorage.getItem(\'best\')) || 0;\n\n// when the game ends:\nif (score > best) {\n  best = score;\n  localStorage.setItem(\'best\', best);\n}\n```']],
};

function followUp(rand, kind) {
  const r = rng(rand);
  return r.pick([...(FOLLOW_UPS[kind] || []), ...FOLLOW_UPS.any]);
}

if (require.main === module) {
  const { playCheck } = require('./gamecheck');
  let seed = 9;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const n = Number(process.argv[2]) || 5;
  let bad = 0;
  let total = 0;
  const lens = [];
  for (const kind of Object.keys(KINDS)) {
    for (let i = 0; i < n; i++) {
      const c = gameConversation(rand, kind);
      total++;
      lens.push(c.reply.length);
      const problem = playCheck(c.html);
      if (problem) { bad++; if (bad <= 10) console.log(`✗ ${kind}: ${problem}`); }
    }
  }
  lens.sort((a, b) => a - b);
  console.log(`${total} games played, ${bad} failed · reply chars p50 ${lens[lens.length >> 1]} max ${lens[lens.length - 1]}`);
  process.exit(bad ? 1 : 0);
}

module.exports = { gameConversation, followUp, KINDS };
