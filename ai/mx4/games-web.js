'use strict';

// Browser games for mx4's training data, written by hand and varied by
// spec (theme, speed, size, controls and optional features), so the model
// sees each game many ways and learns how the pieces fit, not one file.
// Each builder returns { html, notes }: the complete page and what to say
// about it. ai/mx4/gamecheck.js plays every one before it's used.

const THEMES = [
  { name: 'dark', bg: '#0f172a', panel: '#1e293b', fg: '#e2e8f0', accent: '#22c55e', accent2: '#f43f5e', muted: '#94a3b8' },
  { name: 'neon', bg: '#09090b', panel: '#18181b', fg: '#fafafa', accent: '#a855f7', accent2: '#22d3ee', muted: '#a1a1aa' },
  { name: 'ocean', bg: '#082f49', panel: '#0c4a6e', fg: '#e0f2fe', accent: '#38bdf8', accent2: '#fbbf24', muted: '#7dd3fc' },
  { name: 'forest', bg: '#052e16', panel: '#14532d', fg: '#dcfce7', accent: '#4ade80', accent2: '#facc15', muted: '#86efac' },
  { name: 'retro', bg: '#000000', panel: '#111111', fg: '#33ff33', accent: '#33ff33', accent2: '#ff3333', muted: '#22aa22' },
  { name: 'light', bg: '#f8fafc', panel: '#ffffff', fg: '#0f172a', accent: '#2563eb', accent2: '#dc2626', muted: '#64748b' },
  { name: 'sunset', bg: '#431407', panel: '#7c2d12', fg: '#ffedd5', accent: '#fb923c', accent2: '#f472b6', muted: '#fdba74' },
  { name: 'candy', bg: '#fdf2f8', panel: '#ffffff', fg: '#831843', accent: '#ec4899', accent2: '#8b5cf6', muted: '#be185d' },
];
const FONTS = ["system-ui, -apple-system, 'Segoe UI', sans-serif", "'Trebuchet MS', 'Helvetica Neue', sans-serif", "'Courier New', monospace", "Verdana, Geneva, sans-serif"];

function page({ title, t, font, css = '', body, js }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: ${t.bg};
      color: ${t.fg};
      font-family: ${font};
    }
    h1 { margin: 0; font-size: 1.8rem; }
    .hud { display: flex; gap: 24px; font-size: 1.1rem; }
    .hint { color: ${t.muted}; font-size: 0.9rem; }
${css}
  </style>
</head>
<body>
${body}
  <script>
${js}
  </script>
</body>
</html>`;
}

// --- snake -----------------------------------------------------------------------------

function snake(s, r) {
  const { t } = s;
  const cell = r.pick([16, 20, 20, 24]);
  const size = r.pick([400, 400, 480]);
  const speed = r.pick([90, 110, 130, 150]);
  const wrap = r.chance(0.3);
  const speedUp = r.chance(0.4);
  const best = r.chance(0.4);
  const wasd = r.chance(0.5);
  const js = `    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
${best ? "    const bestEl = document.getElementById('best');\n" : ''}    const CELL = ${cell};
    const COLS = canvas.width / CELL;
    const ROWS = canvas.height / CELL;
    const START_SPEED = ${speed}; // milliseconds per move: smaller is faster

    let snake, dir, nextDir, food, score, speed, timer, over;
${best ? "    let best = Number(localStorage.getItem('snake-best')) || 0;\n    bestEl.textContent = best;\n" : ''}
    function reset() {
      snake = [{ x: 5, y: 10 }, { x: 4, y: 10 }, { x: 3, y: 10 }];
      dir = { x: 1, y: 0 };
      nextDir = dir;
      score = 0;
      speed = START_SPEED;
      over = false;
      scoreEl.textContent = score;
      placeFood();
      clearInterval(timer);
      timer = setInterval(step, speed);
      draw();
    }

    function placeFood() {
      do {
        food = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
      } while (snake.some((part) => part.x === food.x && part.y === food.y));
    }

    function step() {
      dir = nextDir;
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
${wrap ? `      // Leaving one side brings you back on the other.
      head.x = (head.x + COLS) % COLS;
      head.y = (head.y + ROWS) % ROWS;
` : `      if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) return gameOver();
`}      if (snake.some((part) => part.x === head.x && part.y === head.y)) return gameOver();
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score++;
        scoreEl.textContent = score;
        placeFood();
${speedUp ? `        // A little faster with every bite.
        speed = Math.max(50, speed - 4);
        clearInterval(timer);
        timer = setInterval(step, speed);
` : ''}      } else {
        snake.pop(); // no food: the tail moves up, so the length stays the same
      }
      draw();
    }

    function draw() {
      ctx.fillStyle = '${t.panel}';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '${t.accent2}';
      ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
      snake.forEach((part, i) => {
        ctx.fillStyle = i === 0 ? '${t.fg}' : '${t.accent}';
        ctx.fillRect(part.x * CELL + 1, part.y * CELL + 1, CELL - 2, CELL - 2);
      });
    }

    function gameOver() {
      over = true;
      clearInterval(timer);
${best ? `      if (score > best) {
        best = score;
        localStorage.setItem('snake-best', best);
        bestEl.textContent = best;
      }
` : ''}      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '28px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Game over!', canvas.width / 2, canvas.height / 2 - 10);
      ctx.font = '16px sans-serif';
      ctx.fillText('Press Space to play again', canvas.width / 2, canvas.height / 2 + 20);
    }

    const KEYS = {
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
${wasd ? '      w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },\n' : ''}    };

    document.addEventListener('keydown', (event) => {
      if (event.key === ' ' && over) return reset();
      const next = KEYS[event.key];
      if (!next) return;
      event.preventDefault();
      // You can't turn straight back into yourself.
      if (next.x === -dir.x && next.y === -dir.y) return;
      nextDir = next;
    });

    reset();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    canvas { background: ${t.panel}; border: 3px solid ${t.accent}; border-radius: 8px; }`,
    body: `  <h1>${s.title}</h1>
  <div class="hud"><span>Score: <b id="score">0</b></span>${best ? '<span>Best: <b id="best">0</b></span>' : ''}</div>
  <canvas id="game" width="${size}" height="${size}"></canvas>
  <p class="hint">Arrow keys${wasd ? ' or WASD' : ''} to move · Space to restart</p>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** steer with the arrow keys${wasd ? ' (or WASD)' : ''}, eat the food to grow, and don’t run into ${wrap ? 'yourself — the edges wrap around' : 'the walls or yourself'}.`,
      `**How it works:** the snake is a list of grid squares. Every ${speed} ms, \`step()\` adds a new head in the current direction and removes the tail — unless it just ate, which is how it grows.${speedUp ? ' Each bite also shortens the timer, so it speeds up.' : ''}${best ? ' The best score is saved with `localStorage`, so it survives a reload.' : ''}`,
      `**Make it yours:** change \`START_SPEED\` to make it faster or slower, \`CELL\` for bigger squares, or the colours in \`draw()\`.`,
    ],
  };
}

// --- pong --------------------------------------------------------------------------------

function pong(s, r) {
  const { t } = s;
  const aiSpeed = r.pick([3, 4, 5]);
  const winScore = r.pick([5, 7, 10]);
  const ballSpeed = r.pick([4, 5, 6]);
  const twoPlayer = r.chance(0.3);
  const mouse = !twoPlayer && r.chance(0.4);
  const js = `    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const PADDLE_W = 12;
    const PADDLE_H = 80;
    const WIN_SCORE = ${winScore};
    const BALL_SPEED = ${ballSpeed};
${twoPlayer ? '' : `    const AI_SPEED = ${aiSpeed}; // how fast the computer's paddle follows the ball\n`}
    const left = { y: H / 2 - PADDLE_H / 2, score: 0 };
    const right = { y: H / 2 - PADDLE_H / 2, score: 0 };
    const ball = { x: W / 2, y: H / 2, dx: BALL_SPEED, dy: 2 };
    const keys = {};
    let winner = null;

    function serve(direction) {
      ball.x = W / 2;
      ball.y = H / 2;
      ball.dx = BALL_SPEED * direction;
      ball.dy = (Math.random() * 4 - 2) || 1;
    }

    function update() {
      if (winner) return;
      // Left paddle: ${mouse ? 'follows the mouse' : 'W and S'}.
${mouse ? '' : `      if (keys.w) left.y -= 6;
      if (keys.s) left.y += 6;
`}      // Right paddle: ${twoPlayer ? 'the arrow keys' : 'the computer chases the ball'}.
${twoPlayer ? `      if (keys.ArrowUp) right.y -= 6;
      if (keys.ArrowDown) right.y += 6;
` : `      const target = ball.y - PADDLE_H / 2;
      right.y += Math.max(-AI_SPEED, Math.min(AI_SPEED, target - right.y));
`}      left.y = Math.max(0, Math.min(H - PADDLE_H, left.y));
      right.y = Math.max(0, Math.min(H - PADDLE_H, right.y));

      ball.x += ball.dx;
      ball.y += ball.dy;
      if (ball.y < 0 || ball.y > H) ball.dy = -ball.dy; // bounce off the top and bottom

      // Hitting a paddle sends the ball back, angled by where it hit.
      if (ball.x < 20 + PADDLE_W && ball.y > left.y && ball.y < left.y + PADDLE_H && ball.dx < 0) {
        ball.dx = -ball.dx * 1.05;
        ball.dy = (ball.y - (left.y + PADDLE_H / 2)) / 8;
      }
      if (ball.x > W - 20 - PADDLE_W && ball.y > right.y && ball.y < right.y + PADDLE_H && ball.dx > 0) {
        ball.dx = -ball.dx * 1.05;
        ball.dy = (ball.y - (right.y + PADDLE_H / 2)) / 8;
      }

      if (ball.x < 0) { right.score++; serve(1); }
      if (ball.x > W) { left.score++; serve(-1); }
      if (left.score >= WIN_SCORE) winner = '${twoPlayer ? 'Left player' : 'You'}';
      if (right.score >= WIN_SCORE) winner = '${twoPlayer ? 'Right player' : 'The computer'}';
    }

    function draw() {
      ctx.fillStyle = '${t.panel}';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '${t.muted}';
      for (let y = 0; y < H; y += 30) ctx.fillRect(W / 2 - 1, y, 2, 15);
      ctx.fillStyle = '${t.accent}';
      ctx.fillRect(20, left.y, PADDLE_W, PADDLE_H);
      ctx.fillRect(W - 20 - PADDLE_W, right.y, PADDLE_W, PADDLE_H);
      ctx.fillStyle = '${t.accent2}';
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '${t.fg}';
      ctx.font = '32px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(left.score, W / 4, 50);
      ctx.fillText(right.score, (W * 3) / 4, 50);
      if (winner) {
        ctx.font = '28px sans-serif';
        ctx.fillText(winner + ' won! Press Space to play again', W / 2, H / 2);
      }
    }

    function loop() {
      update();
      draw();
      requestAnimationFrame(loop);
    }

    document.addEventListener('keydown', (event) => {
      keys[event.key] = true;
      if (event.key === ' ' && winner) {
        left.score = 0;
        right.score = 0;
        winner = null;
        serve(1);
      }
    });
    document.addEventListener('keyup', (event) => { keys[event.key] = false; });
${mouse ? `    canvas.addEventListener('mousemove', (event) => {
      const rect = canvas.getBoundingClientRect();
      left.y = event.clientY - rect.top - PADDLE_H / 2;
    });
` : ''}
    serve(1);
    loop();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    canvas { border: 3px solid ${t.accent}; border-radius: 8px; max-width: 100%; }`,
    body: `  <h1>${s.title}</h1>
  <canvas id="game" width="640" height="400"></canvas>
  <p class="hint">${twoPlayer ? 'Left: W / S · Right: ↑ / ↓' : mouse ? 'Move the mouse to play' : 'W / S to move'} · first to ${winScore} wins</p>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** ${twoPlayer ? 'two players on one keyboard — left uses W and S, right uses the arrow keys' : mouse ? 'move your paddle with the mouse; the computer plays the right side' : 'move your paddle with W and S; the computer plays the right side'}. First to ${winScore} points wins.`,
      `**How it works:** \`loop()\` runs every frame with \`requestAnimationFrame\`: \`update()\` moves the paddles and ball and checks for hits and scores, then \`draw()\` paints everything. Where the ball hits the paddle changes its angle, and every hit makes it 5% faster.`,
      `**Make it yours:** ${twoPlayer ? '' : '`AI_SPEED` sets how good the computer is, '}\`BALL_SPEED\` how fast the ball starts, and \`WIN_SCORE\` how long a game lasts.`,
    ],
  };
}

// --- breakout ----------------------------------------------------------------------------

function breakout(s, r) {
  const { t } = s;
  const rows = r.pick([3, 4, 5]);
  const cols = r.pick([7, 8, 9]);
  const lives = r.pick([3, 3, 5]);
  const speed = r.pick([4, 5]);
  const mouse = r.chance(0.5);
  const js = `    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const ROWS = ${rows};
    const COLS = ${cols};
    const BRICK_H = 20;
    const GAP = 6;
    const BRICK_W = (W - GAP * (COLS + 1)) / COLS;
    const COLORS = ['${t.accent2}', '${t.accent}', '${t.fg}', '${t.muted}', '${t.accent2}'];

    const paddle = { x: W / 2 - 50, w: 100, h: 12 };
    let ball, bricks, score, lives, state;
    const keys = {};

    function newBall() {
      ball = { x: W / 2, y: H - 60, dx: ${speed} * (Math.random() < 0.5 ? -1 : 1), dy: -${speed}, r: 7 };
    }

    function reset() {
      bricks = [];
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          bricks.push({ x: GAP + col * (BRICK_W + GAP), y: 50 + row * (BRICK_H + GAP), row, alive: true });
        }
      }
      score = 0;
      lives = ${lives};
      state = 'playing';
      newBall();
    }

    function update() {
      if (state !== 'playing') return;
${mouse ? '' : `      if (keys.ArrowLeft) paddle.x -= 8;
      if (keys.ArrowRight) paddle.x += 8;
`}      paddle.x = Math.max(0, Math.min(W - paddle.w, paddle.x));

      ball.x += ball.dx;
      ball.y += ball.dy;
      if (ball.x < ball.r || ball.x > W - ball.r) ball.dx = -ball.dx;
      if (ball.y < ball.r) ball.dy = -ball.dy;

      // The paddle: the further from its middle, the sharper the angle.
      if (ball.y > H - 30 - ball.r && ball.y < H - 30 && ball.x > paddle.x && ball.x < paddle.x + paddle.w && ball.dy > 0) {
        ball.dy = -ball.dy;
        ball.dx = ((ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2)) * 6;
      }

      for (const brick of bricks) {
        if (!brick.alive) continue;
        if (ball.x > brick.x && ball.x < brick.x + BRICK_W && ball.y - ball.r < brick.y + BRICK_H && ball.y + ball.r > brick.y) {
          brick.alive = false;
          ball.dy = -ball.dy;
          score += (ROWS - brick.row) * 10;
          break;
        }
      }

      if (ball.y > H) {
        lives--;
        if (lives === 0) state = 'lost';
        else newBall();
      }
      if (bricks.every((brick) => !brick.alive)) state = 'won';
    }

    function draw() {
      ctx.fillStyle = '${t.panel}';
      ctx.fillRect(0, 0, W, H);
      for (const brick of bricks) {
        if (!brick.alive) continue;
        ctx.fillStyle = COLORS[brick.row % COLORS.length];
        ctx.fillRect(brick.x, brick.y, BRICK_W, BRICK_H);
      }
      ctx.fillStyle = '${t.accent}';
      ctx.fillRect(paddle.x, H - 30, paddle.w, paddle.h);
      ctx.fillStyle = '${t.fg}';
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Score: ' + score, 10, 25);
      ctx.textAlign = 'right';
      ctx.fillText('Lives: ' + lives, W - 10, 25);
      if (state !== 'playing') {
        ctx.textAlign = 'center';
        ctx.font = '28px sans-serif';
        ctx.fillText(state === 'won' ? 'You cleared it! 🎉' : 'Game over', W / 2, H / 2);
        ctx.font = '16px sans-serif';
        ctx.fillText('Press Space to play again', W / 2, H / 2 + 30);
      }
    }

    function loop() {
      update();
      draw();
      requestAnimationFrame(loop);
    }

    document.addEventListener('keydown', (event) => {
      keys[event.key] = true;
      if (event.key === ' ' && state !== 'playing') reset();
    });
    document.addEventListener('keyup', (event) => { keys[event.key] = false; });
${mouse ? `    canvas.addEventListener('mousemove', (event) => {
      const rect = canvas.getBoundingClientRect();
      paddle.x = event.clientX - rect.left - paddle.w / 2;
    });
` : ''}
    reset();
    loop();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    canvas { border: 3px solid ${t.accent}; border-radius: 8px; max-width: 100%; }`,
    body: `  <h1>${s.title}</h1>
  <canvas id="game" width="560" height="420"></canvas>
  <p class="hint">${mouse ? 'Move the mouse' : '← → to move'} · Space to restart</p>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** move the paddle with ${mouse ? 'the mouse' : 'the arrow keys'} and bounce the ball into the bricks. Clear them all to win; you have ${lives} lives.`,
      `**How it works:** the bricks are a list of objects with an \`alive\` flag. Each frame the ball moves, bounces off the walls and paddle, and the first live brick it overlaps is knocked out. Higher rows are worth more points.`,
      `**Make it yours:** change \`ROWS\` and \`COLS\` for more bricks, the ball’s starting speed in \`newBall()\`, or \`paddle.w\` to make it easier.`,
    ],
  };
}

// --- flappy ------------------------------------------------------------------------------

function flappy(s, r) {
  const { t } = s;
  const hero = r.pick([['🐤', 'bird'], ['🚀', 'rocket'], ['🐟', 'fish'], ['🦇', 'bat'], ['🐝', 'bee']]);
  const gap = r.pick([130, 150, 170]);
  const gravity = r.pick([0.4, 0.45, 0.5]);
  const speed = r.pick([2.5, 3, 3.5]);
  const js = `    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const GRAVITY = ${gravity};
    const FLAP = -7.5;
    const GAP = ${gap}; // space between the top and bottom pipes
    const PIPE_W = 60;
    const SPEED = ${speed};

    let player, pipes, score, state, frame;
    let best = 0;

    function reset() {
      player = { x: 80, y: H / 2, vy: 0 };
      pipes = [];
      score = 0;
      frame = 0;
      state = 'ready';
    }

    function flap() {
      if (state === 'over') return reset();
      state = 'playing';
      player.vy = FLAP;
    }

    function update() {
      if (state !== 'playing') return;
      frame++;
      player.vy += GRAVITY;
      player.y += player.vy;

      // A new pair of pipes every 90 frames, with the gap somewhere random.
      if (frame % 90 === 0) {
        const top = 40 + Math.random() * (H - GAP - 80);
        pipes.push({ x: W, top, passed: false });
      }
      for (const pipe of pipes) {
        pipe.x -= SPEED;
        if (!pipe.passed && pipe.x + PIPE_W < player.x) {
          pipe.passed = true;
          score++;
          best = Math.max(best, score);
        }
        const inPipeX = player.x + 14 > pipe.x && player.x - 14 < pipe.x + PIPE_W;
        const inGap = player.y - 14 > pipe.top && player.y + 14 < pipe.top + GAP;
        if (inPipeX && !inGap) state = 'over';
      }
      pipes = pipes.filter((pipe) => pipe.x > -PIPE_W);
      if (player.y > H || player.y < 0) state = 'over';
    }

    function draw() {
      ctx.fillStyle = '${t.panel}';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '${t.accent}';
      for (const pipe of pipes) {
        ctx.fillRect(pipe.x, 0, PIPE_W, pipe.top);
        ctx.fillRect(pipe.x, pipe.top + GAP, PIPE_W, H - pipe.top - GAP);
      }
      ctx.font = '32px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('${hero[0]}', player.x, player.y);
      ctx.fillStyle = '${t.fg}';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText(score, W / 2, 40);
      ctx.font = '18px sans-serif';
      if (state === 'ready') ctx.fillText('Press Space or click to flap', W / 2, H / 2 + 60);
      if (state === 'over') {
        ctx.fillText('Game over — best: ' + best, W / 2, H / 2);
        ctx.fillText('Press Space to try again', W / 2, H / 2 + 30);
      }
    }

    function loop() {
      update();
      draw();
      requestAnimationFrame(loop);
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'ArrowUp') {
        event.preventDefault();
        flap();
      }
    });
    canvas.addEventListener('mousedown', flap);

    reset();
    loop();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    canvas { border: 3px solid ${t.accent}; border-radius: 8px; max-width: 100%; cursor: pointer; }`,
    body: `  <h1>${s.title}</h1>
  <canvas id="game" width="400" height="560"></canvas>
  <p class="hint">Space, ↑ or click to flap</p>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** press Space (or click) to flap your ${hero[1]} up; gravity pulls it down. Fly through the gaps between the pipes — every pipe you pass is a point.`,
      `**How it works:** each frame adds \`GRAVITY\` to the ${hero[1]}’s vertical speed, and a flap sets it to \`FLAP\` (upwards). Pipes are added every 90 frames and slide left; touching one, or the top or bottom, ends the game.`,
      `**Make it yours:** a bigger \`GAP\` or smaller \`GRAVITY\` makes it easier; change the emoji in \`draw()\` to fly something else.`,
    ],
  };
}

// --- tic-tac-toe -------------------------------------------------------------------------

function tictactoe(s, r) {
  const { t } = s;
  const vsComputer = r.chance(0.5);
  const marks = r.pick([['X', 'O'], ['X', 'O'], ['❌', '⭕'], ['🐱', '🐶']]);
  const js = `    const board = document.getElementById('board');
    const status = document.getElementById('status');
    const LINES = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
      [0, 4, 8], [2, 4, 6], // diagonals
    ];
    const PLAYERS = ['${marks[0]}', '${marks[1]}'];

    let cells, turn, done;

    function winner() {
      for (const [a, b, c] of LINES) {
        if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
      }
      return cells.every(Boolean) ? 'draw' : null;
    }

    function play(i) {
      if (done || cells[i]) return;
      cells[i] = PLAYERS[turn];
      turn = 1 - turn;
      render();
${vsComputer ? `      if (!done && turn === 1) setTimeout(computerMove, 300);
` : ''}    }
${vsComputer ? `
    // The computer wins if it can, blocks you if it must, else takes the
    // centre, a corner, or anything left.
    function computerMove() {
      const free = cells.map((c, i) => (c ? null : i)).filter((i) => i !== null);
      const completes = (mark) => free.find((i) => {
        cells[i] = mark;
        const won = winner() === mark;
        cells[i] = null;
        return won;
      });
      const choice = completes(PLAYERS[1]) ?? completes(PLAYERS[0])
        ?? [4, 0, 2, 6, 8].find((i) => free.includes(i)) ?? free[0];
      if (choice !== undefined) play(choice);
    }
` : ''}
    function render() {
      board.innerHTML = '';
      cells.forEach((mark, i) => {
        const cell = document.createElement('button');
        cell.className = 'cell';
        cell.textContent = mark || '';
        cell.addEventListener('click', () => ${vsComputer ? 'turn === 0 && play(i)' : 'play(i)'});
        board.appendChild(cell);
      });
      const w = winner();
      done = Boolean(w);
      if (w === 'draw') status.textContent = "It's a draw!";
      else if (w) status.textContent = w + ' wins! 🎉';
      else status.textContent = ${vsComputer ? "turn === 0 ? 'Your turn (' + PLAYERS[0] + ')' : 'Computer is thinking…'" : "PLAYERS[turn] + \"'s turn\""};
    }

    function reset() {
      cells = Array(9).fill(null);
      turn = 0;
      done = false;
      render();
    }

    document.getElementById('restart').addEventListener('click', reset);
    reset();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    #board { display: grid; grid-template-columns: repeat(3, 100px); gap: 8px; }
    .cell {
      width: 100px;
      height: 100px;
      font-size: 2.6rem;
      background: ${t.panel};
      color: ${t.fg};
      border: 2px solid ${t.accent};
      border-radius: 12px;
      cursor: pointer;
    }
    .cell:hover { background: ${t.bg}; }
    #status { font-size: 1.2rem; min-height: 1.5em; }
    #restart { padding: 10px 20px; font: inherit; background: ${t.accent}; color: ${t.bg}; border: none; border-radius: 8px; cursor: pointer; }`,
    body: `  <h1>${s.title}</h1>
  <p id="status"></p>
  <div id="board"></div>
  <button id="restart">New game</button>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** ${vsComputer ? `you’re ${marks[0]}, the computer is ${marks[1]}` : `two players take turns, ${marks[0]} first`}. Get three in a row — across, down or diagonally — to win.`,
      `**How it works:** the board is an array of 9 cells. \`LINES\` lists the 8 ways to win, and \`winner()\` checks each one.${vsComputer ? ' The computer tries every free cell to see if it can win or must block you, otherwise it prefers the centre and corners.' : ''} \`render()\` rebuilds the buttons after every move.`,
      `**Make it yours:** change \`PLAYERS\` to use different symbols, or the colours in the \`.cell\` style.`,
    ],
  };
}

// --- memory ------------------------------------------------------------------------------

const EMOJI_SETS = {
  animals: ['🐶', '🐱', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐷'],
  fruit: ['🍎', '🍌', '🍇', '🍓', '🍒', '🍍', '🥝', '🍑', '🍉', '🍋'],
  space: ['🚀', '🌙', '⭐', '🪐', '☄️', '🛸', '🌍', '☀️', '👽', '🌌'],
  sports: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏓', '🎱', '🥊', '⛳'],
  food: ['🍕', '🍔', '🌮', '🍣', '🍩', '🍪', '🧁', '🍦', '🥨', '🍟'],
};

function memory(s, r) {
  const { t } = s;
  const setName = r.pick(Object.keys(EMOJI_SETS));
  const pairs = r.pick([6, 8, 8]);
  const timer = r.chance(0.5);
  const js = `    const SYMBOLS = ${JSON.stringify(EMOJI_SETS[setName].slice(0, pairs))};
    const grid = document.getElementById('grid');
    const movesEl = document.getElementById('moves');
${timer ? "    const timeEl = document.getElementById('time');\n" : ''}    const message = document.getElementById('message');

    let first = null;
    let busy = false;
    let moves = 0;
    let matched = 0;
${timer ? '    let seconds = 0;\n    let clock = null;\n' : ''}
    function shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }

    function start() {
      grid.innerHTML = '';
      first = null;
      busy = false;
      moves = 0;
      matched = 0;
      movesEl.textContent = 0;
      message.textContent = '';
${timer ? `      seconds = 0;
      timeEl.textContent = 0;
      clearInterval(clock);
      clock = null;
` : ''}      for (const symbol of shuffle([...SYMBOLS, ...SYMBOLS])) {
        const card = document.createElement('button');
        card.className = 'card';
        card.dataset.symbol = symbol;
        card.addEventListener('click', () => flip(card));
        grid.appendChild(card);
      }
    }

    function flip(card) {
      if (busy || card === first || card.classList.contains('open')) return;
${timer ? `      if (!clock) clock = setInterval(() => { seconds++; timeEl.textContent = seconds; }, 1000);
` : ''}      card.classList.add('open');
      card.textContent = card.dataset.symbol;
      if (!first) {
        first = card;
        return;
      }
      moves++;
      movesEl.textContent = moves;
      if (first.dataset.symbol === card.dataset.symbol) {
        first = null;
        matched++;
        if (matched === SYMBOLS.length) {
${timer ? '          clearInterval(clock);\n' : ''}          message.textContent = 'You found them all in ' + moves + ' moves${timer ? " and ' + seconds + ' seconds" : ''}! 🎉';
        }
        return;
      }
      // Not a match: show both for a moment, then turn them back over.
      busy = true;
      const other = first;
      first = null;
      setTimeout(() => {
        for (const c of [other, card]) {
          c.classList.remove('open');
          c.textContent = '';
        }
        busy = false;
      }, 800);
    }

    document.getElementById('restart').addEventListener('click', start);
    start();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    #grid { display: grid; grid-template-columns: repeat(4, 80px); gap: 10px; }
    .card {
      width: 80px;
      height: 80px;
      font-size: 2.2rem;
      background: ${t.accent};
      border: none;
      border-radius: 12px;
      cursor: pointer;
      transition: transform 0.2s;
    }
    .card.open { background: ${t.panel}; transform: rotateY(180deg); }
    #message { min-height: 1.5em; font-size: 1.1rem; }
    #restart { padding: 10px 20px; font: inherit; background: ${t.accent2}; color: #fff; border: none; border-radius: 8px; cursor: pointer; }`,
    body: `  <h1>${s.title}</h1>
  <div class="hud"><span>Moves: <b id="moves">0</b></span>${timer ? '<span>Time: <b id="time">0</b>s</span>' : ''}</div>
  <div id="grid"></div>
  <p id="message"></p>
  <button id="restart">New game</button>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** flip two cards at a time to find matching ${setName} pairs. Find all ${pairs} pairs in as few moves as you can${timer ? ', against the clock' : ''}.`,
      `**How it works:** the deck is every symbol twice, shuffled with the Fisher–Yates shuffle. The first card you flip is remembered; when the second matches, both stay open, otherwise they flip back after 800 ms (\`busy\` stops clicks meanwhile).`,
      `**Make it yours:** put your own emoji in \`SYMBOLS\` (add more for a harder game and widen the grid in the CSS).`,
    ],
  };
}

// --- whack-a-mole ------------------------------------------------------------------------

function whack(s, r) {
  const { t } = s;
  const critter = r.pick([['🐹', 'mole'], ['🐭', 'mouse'], ['👾', 'alien'], ['🐸', 'frog'], ['🦫', 'beaver']]);
  const seconds = r.pick([20, 30, 30]);
  const holes = r.pick([9, 9, 12]);
  const js = `    const GAME_SECONDS = ${seconds};
    const HOLES = ${holes};
    const grid = document.getElementById('grid');
    const scoreEl = document.getElementById('score');
    const timeEl = document.getElementById('time');
    const startButton = document.getElementById('start');

    let score = 0;
    let timeLeft = 0;
    let active = -1;
    let popTimer = null;
    let clock = null;

    for (let i = 0; i < HOLES; i++) {
      const hole = document.createElement('button');
      hole.className = 'hole';
      hole.addEventListener('click', () => whack(i, hole));
      grid.appendChild(hole);
    }
    const holes = grid.children;

    function popUp() {
      if (active >= 0) holes[active].textContent = '';
      active = Math.floor(Math.random() * HOLES);
      holes[active].textContent = '${critter[0]}';
      // It hides again faster as the clock runs down.
      popTimer = setTimeout(popUp, 500 + timeLeft * 20);
    }

    function whack(i, hole) {
      if (i !== active || timeLeft <= 0) return;
      score++;
      scoreEl.textContent = score;
      hole.textContent = '💥';
      active = -1;
    }

    function start() {
      score = 0;
      timeLeft = GAME_SECONDS;
      scoreEl.textContent = 0;
      timeEl.textContent = timeLeft;
      startButton.disabled = true;
      clearTimeout(popTimer);
      clearInterval(clock);
      popUp();
      clock = setInterval(() => {
        timeLeft--;
        timeEl.textContent = timeLeft;
        if (timeLeft <= 0) end();
      }, 1000);
    }

    function end() {
      clearInterval(clock);
      clearTimeout(popTimer);
      for (const hole of holes) hole.textContent = '';
      startButton.disabled = false;
      startButton.textContent = 'Play again (score: ' + score + ')';
    }

    startButton.addEventListener('click', start);`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    #grid { display: grid; grid-template-columns: repeat(${holes === 12 ? 4 : 3}, 90px); gap: 12px; }
    .hole {
      width: 90px;
      height: 90px;
      font-size: 2.6rem;
      background: ${t.panel};
      border: 3px solid ${t.accent};
      border-radius: 50%;
      cursor: pointer;
    }
    #start { padding: 10px 20px; font: inherit; background: ${t.accent}; color: ${t.bg}; border: none; border-radius: 8px; cursor: pointer; }
    #start:disabled { opacity: 0.5; cursor: default; }`,
    body: `  <h1>${s.title}</h1>
  <div class="hud"><span>Score: <b id="score">0</b></span><span>Time: <b id="time">${seconds}</b>s</span></div>
  <div id="grid"></div>
  <button id="start">Start</button>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** press Start, then click the ${critter[1]} ${critter[0]} as fast as you can before it hides. You have ${seconds} seconds.`,
      `**How it works:** \`popUp()\` shows the ${critter[1]} in a random hole and schedules itself again with \`setTimeout\` — sooner as time runs out, so it gets harder. A click only scores if it’s on the hole that’s \`active\`.`,
      `**Make it yours:** change \`GAME_SECONDS\`, the number of \`HOLES\`, or the emoji.`,
    ],
  };
}

// --- shooter -----------------------------------------------------------------------------

function shooter(s, r) {
  const { t } = s;
  const ship = r.pick(['🚀', '🛸', '✈️']);
  const enemy = r.pick(['👾', '👽', '🛸', '☄️']);
  const spawn = r.pick([40, 50, 60]);
  const lives = r.pick([3, 5]);
  const js = `    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const SPAWN_EVERY = ${spawn}; // frames between enemies: smaller is harder

    const keys = {};
    let player, bullets, enemies, stars, score, lives, frame, cooldown, over;

    function reset() {
      player = { x: W / 2, y: H - 50 };
      bullets = [];
      enemies = [];
      stars = Array.from({ length: 60 }, () => ({ x: Math.random() * W, y: Math.random() * H, speed: 1 + Math.random() * 2 }));
      score = 0;
      lives = ${lives};
      frame = 0;
      cooldown = 0;
      over = false;
    }

    function update() {
      for (const star of stars) {
        star.y += star.speed;
        if (star.y > H) star.y = 0;
      }
      if (over) return;
      frame++;
      if (keys.ArrowLeft || keys.a) player.x -= 6;
      if (keys.ArrowRight || keys.d) player.x += 6;
      player.x = Math.max(20, Math.min(W - 20, player.x));

      cooldown--;
      if (keys[' '] && cooldown <= 0) {
        bullets.push({ x: player.x, y: player.y - 20 });
        cooldown = 12;
      }
      for (const b of bullets) b.y -= 9;
      bullets = bullets.filter((b) => b.y > 0);

      // Enemies come faster as your score goes up.
      if (frame % Math.max(15, SPAWN_EVERY - score) === 0) {
        enemies.push({ x: 20 + Math.random() * (W - 40), y: -20, speed: 1.5 + Math.random() * 2 + score / 20 });
      }
      for (const e of enemies) e.y += e.speed;

      for (const e of enemies) {
        for (const b of bullets) {
          if (Math.abs(e.x - b.x) < 20 && Math.abs(e.y - b.y) < 20) {
            e.hit = true;
            b.y = -100;
            score++;
          }
        }
        if (!e.hit && (e.y > H || (Math.abs(e.x - player.x) < 26 && Math.abs(e.y - player.y) < 26))) {
          e.hit = true;
          lives--;
          if (lives <= 0) over = true;
        }
      }
      enemies = enemies.filter((e) => !e.hit);
    }

    function draw() {
      ctx.fillStyle = '${t.bg}';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '${t.muted}';
      for (const star of stars) ctx.fillRect(star.x, star.y, 2, 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '30px serif';
      ctx.fillText('${ship}', player.x, player.y);
      for (const e of enemies) ctx.fillText('${enemy}', e.x, e.y);
      ctx.fillStyle = '${t.accent2}';
      for (const b of bullets) ctx.fillRect(b.x - 2, b.y - 8, 4, 12);
      ctx.fillStyle = '${t.fg}';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Score: ' + score, 12, 24);
      ctx.textAlign = 'right';
      ctx.fillText('❤️'.repeat(Math.max(0, lives)), W - 12, 24);
      if (over) {
        ctx.textAlign = 'center';
        ctx.font = '30px sans-serif';
        ctx.fillText('Game over! Score: ' + score, W / 2, H / 2);
        ctx.font = '18px sans-serif';
        ctx.fillText('Press R to restart', W / 2, H / 2 + 34);
      }
    }

    function loop() {
      update();
      draw();
      requestAnimationFrame(loop);
    }

    document.addEventListener('keydown', (event) => {
      keys[event.key] = true;
      if (event.key === ' ') event.preventDefault();
      if (event.key === 'r' && over) reset();
    });
    document.addEventListener('keyup', (event) => { keys[event.key] = false; });

    reset();
    loop();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    canvas { border: 3px solid ${t.accent}; border-radius: 8px; max-width: 100%; }`,
    body: `  <h1>${s.title}</h1>
  <canvas id="game" width="480" height="600"></canvas>
  <p class="hint">← → or A / D to move · Space to shoot · R to restart</p>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** move your ${ship} with the arrow keys (or A and D) and hold Space to shoot the ${enemy} before they reach you. Each one that gets past or hits you costs a life.`,
      `**How it works:** the player, bullets, enemies and background stars are plain objects in arrays. Every frame they move, bullets that overlap an enemy remove it, and \`filter\` clears out anything that’s gone. Enemies spawn more often and fall faster as your score rises.`,
      `**Make it yours:** \`SPAWN_EVERY\` controls how busy it gets, \`cooldown\` how fast you can shoot, and the emoji in \`draw()\` the look.`,
    ],
  };
}

// --- catch ---------------------------------------------------------------------------------

function catcher(s, r) {
  const { t } = s;
  const pairs = r.pick([[['🍎', '🍌', '🍇'], '🧺', 'fruit', 'basket'], [['⭐', '🌟', '✨'], '🫙', 'stars', 'jar'], [['🍩', '🍪', '🧁'], '🍽️', 'treats', 'plate'], [['💎', '🪙', '💰'], '🎩', 'treasure', 'hat']]);
  const [goods, holder, what, holderName] = pairs;
  const bomb = r.chance(0.6);
  const seconds = r.pick([30, 45, 60]);
  const js = `    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const GOODS = ${JSON.stringify(goods)};
    const GAME_SECONDS = ${seconds};

    const keys = {};
    let catcher, falling, score, timeLeft, frame, playing;

    function start() {
      catcher = { x: W / 2 };
      falling = [];
      score = 0;
      timeLeft = GAME_SECONDS;
      frame = 0;
      playing = true;
    }

    function update() {
      if (!playing) return;
      frame++;
      if (frame % 60 === 0) {
        timeLeft--;
        if (timeLeft <= 0) playing = false;
      }
      if (keys.ArrowLeft) catcher.x -= 7;
      if (keys.ArrowRight) catcher.x += 7;
      catcher.x = Math.max(30, Math.min(W - 30, catcher.x));

      if (frame % 35 === 0) {
${bomb ? `        const isBomb = Math.random() < 0.2;
        falling.push({ x: 20 + Math.random() * (W - 40), y: -20, speed: 2 + Math.random() * 3, emoji: isBomb ? '💣' : GOODS[Math.floor(Math.random() * GOODS.length)], bomb: isBomb });
` : `        falling.push({ x: 20 + Math.random() * (W - 40), y: -20, speed: 2 + Math.random() * 3, emoji: GOODS[Math.floor(Math.random() * GOODS.length)] });
`}      }
      for (const item of falling) {
        item.y += item.speed;
        if (item.y > H - 60 && item.y < H - 20 && Math.abs(item.x - catcher.x) < 35) {
          item.caught = true;
${bomb ? '          score += item.bomb ? -5 : 1;\n' : '          score++;\n'}        }
      }
      falling = falling.filter((item) => !item.caught && item.y < H + 20);
    }

    function draw() {
      ctx.fillStyle = '${t.panel}';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '30px serif';
      for (const item of falling) ctx.fillText(item.emoji, item.x, item.y);
      ctx.font = '44px serif';
      ctx.fillText('${holder}', catcher.x, H - 40);
      ctx.fillStyle = '${t.fg}';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Score: ' + score, 12, 24);
      ctx.textAlign = 'right';
      ctx.fillText('Time: ' + timeLeft, W - 12, 24);
      if (!playing) {
        ctx.textAlign = 'center';
        ctx.font = '28px sans-serif';
        ctx.fillText("Time's up! You scored " + score, W / 2, H / 2);
        ctx.font = '18px sans-serif';
        ctx.fillText('Press Space to play again', W / 2, H / 2 + 32);
      }
    }

    function loop() {
      update();
      draw();
      requestAnimationFrame(loop);
    }

    document.addEventListener('keydown', (event) => {
      keys[event.key] = true;
      if (event.key === ' ' && !playing) start();
    });
    document.addEventListener('keyup', (event) => { keys[event.key] = false; });

    start();
    loop();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    canvas { border: 3px solid ${t.accent}; border-radius: 8px; max-width: 100%; }`,
    body: `  <h1>${s.title}</h1>
  <canvas id="game" width="480" height="560"></canvas>
  <p class="hint">← → to move${bomb ? ' · avoid the 💣' : ''}</p>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** move the ${holderName} with the arrow keys and catch the falling ${what}${bomb ? ' — but not the bombs, which cost 5 points' : ''}. You have ${seconds} seconds.`,
      `**How it works:** every 35 frames a new item starts above the screen at a random spot and speed. Each frame it falls; if it reaches the ${holderName}’s height close enough to it, it’s caught and scored.`,
      `**Make it yours:** change \`GOODS\` to catch different things, \`GAME_SECONDS\` for a longer game, or the \`35\` in \`update()\` to drop things more often.`,
    ],
  };
}

// --- small DOM games -----------------------------------------------------------------------

function guess(s, r) {
  const { t } = s;
  const max = r.pick([10, 50, 100]);
  const limit = r.chance(0.5) ? r.pick([5, 7, 10]) : 0;
  const js = `    const MAX = ${max};
${limit ? `    const MAX_TRIES = ${limit};\n` : ''}    const form = document.getElementById('form');
    const input = document.getElementById('guess');
    const message = document.getElementById('message');
    const triesEl = document.getElementById('tries');

    let secret, tries, finished;

    function newGame() {
      secret = Math.floor(Math.random() * MAX) + 1;
      tries = 0;
      finished = false;
      triesEl.textContent = 0;
      message.textContent = 'I’m thinking of a number from 1 to ' + MAX + '.';
      input.value = '';
      input.focus();
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault(); // stop the page from reloading
      if (finished) return newGame();
      const guess = Number(input.value);
      if (!Number.isInteger(guess) || guess < 1 || guess > MAX) {
        message.textContent = 'Please enter a whole number from 1 to ' + MAX + '.';
        return;
      }
      tries++;
      triesEl.textContent = tries;
      if (guess === secret) {
        message.textContent = '🎉 Yes! It was ' + secret + '. You got it in ' + tries + (tries === 1 ? ' try' : ' tries') + '. Press Enter to play again.';
        finished = true;
${limit ? `      } else if (tries >= MAX_TRIES) {
        message.textContent = 'Out of tries! It was ' + secret + '. Press Enter to play again.';
        finished = true;
` : ''}      } else {
        message.textContent = guess < secret ? '⬆️ Higher!' : '⬇️ Lower!';
      }
      input.value = '';
    });

    newGame();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    form { display: flex; gap: 8px; }
    input { padding: 10px; font: inherit; width: 120px; border-radius: 8px; border: 2px solid ${t.accent}; background: ${t.panel}; color: ${t.fg}; }
    button { padding: 10px 20px; font: inherit; background: ${t.accent}; color: ${t.bg}; border: none; border-radius: 8px; cursor: pointer; }
    #message { font-size: 1.2rem; min-height: 1.5em; text-align: center; max-width: 90vw; }`,
    body: `  <h1>${s.title}</h1>
  <p id="message"></p>
  <form id="form">
    <input id="guess" type="number" min="1" max="${max}" autocomplete="off">
    <button type="submit">Guess</button>
  </form>
  <p class="hint">Tries: <b id="tries">0</b>${limit ? ` of ${limit}` : ''}</p>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** guess the secret number from 1 to ${max}; after each guess you’re told to go higher or lower${limit ? `. You have ${limit} tries` : ''}.`,
      '**How it works:** the guess is checked in the form’s `submit` handler — `event.preventDefault()` stops the page reloading — and `Number()` turns the text into a number. A good strategy is to guess the middle each time (binary search).',
      `**Make it yours:** change \`MAX\` for a bigger range${limit ? ' or `MAX_TRIES` for more chances' : ''}.`,
    ],
  };
}

function rps(s, r) {
  const { t } = s;
  const bestOf = r.pick([0, 3, 5]);
  const js = `    const MOVES = { rock: '✊', paper: '✋', scissors: '✌️' };
    const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
${bestOf ? `    const FIRST_TO = ${Math.ceil(bestOf / 2)};\n` : ''}    const result = document.getElementById('result');
    const youEl = document.getElementById('you');
    const cpuEl = document.getElementById('cpu');
    let you = 0;
    let cpu = 0;

    function play(move) {
${bestOf ? '      if (you >= FIRST_TO || cpu >= FIRST_TO) { you = 0; cpu = 0; }\n' : ''}      const names = Object.keys(MOVES);
      const computer = names[Math.floor(Math.random() * names.length)];
      let text = MOVES[move] + ' vs ' + MOVES[computer] + ' — ';
      if (move === computer) {
        text += "it's a tie!";
      } else if (BEATS[move] === computer) {
        you++;
        text += 'you win! 🎉';
      } else {
        cpu++;
        text += 'the computer wins.';
      }
${bestOf ? `      if (you === FIRST_TO) text += ' You won the match!';
      if (cpu === FIRST_TO) text += ' The computer won the match.';
` : ''}      result.textContent = text;
      youEl.textContent = you;
      cpuEl.textContent = cpu;
    }

    for (const button of document.querySelectorAll('.move')) {
      button.addEventListener('click', () => play(button.dataset.move));
    }`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    .moves { display: flex; gap: 12px; }
    .move { font-size: 2.6rem; width: 90px; height: 90px; background: ${t.panel}; border: 3px solid ${t.accent}; border-radius: 16px; cursor: pointer; }
    .move:hover { transform: scale(1.08); }
    #result { font-size: 1.3rem; min-height: 1.5em; }`,
    body: `  <h1>${s.title}</h1>
  <div class="hud"><span>You: <b id="you">0</b></span><span>Computer: <b id="cpu">0</b></span></div>
  <div class="moves">
    <button class="move" data-move="rock">✊</button>
    <button class="move" data-move="paper">✋</button>
    <button class="move" data-move="scissors">✌️</button>
  </div>
  <p id="result">Make your move!</p>${bestOf ? `\n  <p class="hint">Best of ${bestOf}</p>` : ''}`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** click rock, paper or scissors; the computer picks at random${bestOf ? `. First to ${Math.ceil(bestOf / 2)} wins the match` : ''}.`,
      '**How it works:** `BEATS` says what each move defeats, so one lookup decides the winner. Each button stores its move in a `data-move` attribute, read with `button.dataset.move`.',
      '**Make it yours:** add lizard and Spock by extending `MOVES` and `BEATS` (each would then beat two moves — make `BEATS` values arrays).',
    ],
  };
}

function clicker(s, r) {
  const { t } = s;
  const thing = r.pick([['🍪', 'cookies'], ['💎', 'gems'], ['🍩', 'donuts'], ['⚡', 'energy'], ['🌮', 'tacos']]);
  const js = `    const countEl = document.getElementById('count');
    const rateEl = document.getElementById('rate');
    const big = document.getElementById('big');
    const shop = document.getElementById('shop');

    let count = 0;
    let perClick = 1;
    let perSecond = 0;

    // Each upgrade gets 50% more expensive every time you buy it.
    const UPGRADES = [
      { name: 'Better clicks', cost: 15, apply: () => { perClick += 1; } },
      { name: 'Helper', cost: 50, apply: () => { perSecond += 1; } },
      { name: 'Factory', cost: 300, apply: () => { perSecond += 8; } },
    ];

    function render() {
      countEl.textContent = Math.floor(count);
      rateEl.textContent = perSecond;
      shop.innerHTML = '';
      for (const upgrade of UPGRADES) {
        const button = document.createElement('button');
        button.textContent = upgrade.name + ' — ' + upgrade.cost;
        button.disabled = count < upgrade.cost;
        button.addEventListener('click', () => {
          if (count < upgrade.cost) return;
          count -= upgrade.cost;
          upgrade.cost = Math.ceil(upgrade.cost * 1.5);
          upgrade.apply();
          render();
        });
        shop.appendChild(button);
      }
    }

    big.addEventListener('click', () => {
      count += perClick;
      render();
    });

    setInterval(() => {
      count += perSecond / 10;
      render();
    }, 100);

    render();`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    #big { font-size: 6rem; background: none; border: none; cursor: pointer; transition: transform 0.08s; }
    #big:active { transform: scale(0.9); }
    #shop { display: flex; flex-direction: column; gap: 8px; }
    #shop button { padding: 10px 16px; font: inherit; background: ${t.accent}; color: ${t.bg}; border: none; border-radius: 8px; cursor: pointer; }
    #shop button:disabled { opacity: 0.4; cursor: default; }`,
    body: `  <h1>${s.title}</h1>
  <div class="hud"><span>${thing[1]}: <b id="count">0</b></span><span>per second: <b id="rate">0</b></span></div>
  <button id="big">${thing[0]}</button>
  <div id="shop"></div>`,
    js,
  });
  return {
    html,
    notes: [
      `**How to play:** click the ${thing[0]} to earn ${thing[1]}, then spend them on upgrades that earn more for you — even when you’re not clicking.`,
      '**How it works:** `setInterval` adds a tenth of your per-second rate ten times a second. Each upgrade is an object with a cost and an `apply` function; buying one makes it 50% pricier. `render()` redraws the numbers and enables only the upgrades you can afford.',
      '**Make it yours:** add new entries to `UPGRADES`, or save progress with `localStorage.setItem` so it survives a reload.',
    ],
  };
}

function reaction(s, r) {
  const { t } = s;
  const js = `    const box = document.getElementById('box');
    const best = document.getElementById('best');
    let state = 'idle';
    let startedAt = 0;
    let timer = null;
    let bestTime = Infinity;

    function show(text, color) {
      box.textContent = text;
      box.style.background = color;
    }

    box.addEventListener('click', () => {
      if (state === 'idle' || state === 'done') {
        state = 'waiting';
        show('Wait for green…', '${t.accent2}');
        // Turns green after 1–4 seconds, so you can't predict it.
        timer = setTimeout(() => {
          state = 'go';
          startedAt = performance.now();
          show('Click!', '#22c55e');
        }, 1000 + Math.random() * 3000);
      } else if (state === 'waiting') {
        clearTimeout(timer);
        state = 'done';
        show('Too soon! Click to try again', '${t.panel}');
      } else if (state === 'go') {
        const ms = Math.round(performance.now() - startedAt);
        bestTime = Math.min(bestTime, ms);
        best.textContent = bestTime + ' ms';
        state = 'done';
        show(ms + ' ms — click to go again', '${t.panel}');
      }
    });`;
  const html = page({
    title: s.title, t, font: s.font,
    css: `    #box {
      width: min(90vw, 420px);
      height: 260px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      border-radius: 16px;
      background: ${t.panel};
      border: 3px solid ${t.accent};
      cursor: pointer;
      user-select: none;
    }`,
    body: `  <h1>${s.title}</h1>
  <div id="box">Click to start</div>
  <p class="hint">Best: <b id="best">—</b></p>`,
    js,
  });
  return {
    html,
    notes: [
      '**How to play:** click the box, wait for it to turn green, then click as fast as you can. Clicking too early doesn’t count.',
      '**How it works:** the game is a small state machine (`idle` → `waiting` → `go` → `done`). A random `setTimeout` turns it green, and `performance.now()` measures your reaction to the millisecond.',
      '**Make it yours:** keep the last five times and show the average, or play a sound when it turns green.',
    ],
  };
}

const BUILDERS = { snake, pong, breakout, flappy, tictactoe, memory, whack, shooter, catcher, guess, rps, clicker, reaction };

module.exports = { BUILDERS, THEMES, FONTS };
