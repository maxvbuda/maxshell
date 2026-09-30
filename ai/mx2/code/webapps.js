'use strict';

// Complete single-file web apps (HTML + CSS + JavaScript). validate.js
// checks that every tag is closed properly and every script parses.

module.exports = [
  {
    task: 'a to-do list web app',
    asks: ['make a todo list website', 'build a to-do app in html css and javascript', 'code a todo list that saves tasks', 'make me a task list app for the browser', 'todo app with local storage'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>To-Do List</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f4f6fb; display: flex; justify-content: center; padding: 40px 16px; }
    .app { background: white; width: 100%; max-width: 420px; padding: 24px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08); }
    h1 { margin-top: 0; }
    form { display: flex; gap: 8px; }
    input { flex: 1; padding: 10px 12px; border: 1px solid #ccd; border-radius: 8px; font-size: 16px; }
    button { padding: 10px 16px; border: none; border-radius: 8px; background: #4f6df5; color: white; font-size: 16px; cursor: pointer; }
    ul { list-style: none; padding: 0; margin: 20px 0 0; }
    li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #eee; }
    li.done span { text-decoration: line-through; color: #999; }
    li span { flex: 1; cursor: pointer; }
    .delete { background: none; color: #d33; padding: 4px 8px; }
  </style>
</head>
<body>
  <div class="app">
    <h1>To-Do List</h1>
    <form id="form">
      <input id="task" placeholder="What needs doing?" autocomplete="off">
      <button type="submit">Add</button>
    </form>
    <ul id="list"></ul>
  </div>
  <script>
    const form = document.getElementById('form');
    const input = document.getElementById('task');
    const list = document.getElementById('list');
    let todos = JSON.parse(localStorage.getItem('todos') || '[]');

    function save() {
      localStorage.setItem('todos', JSON.stringify(todos));
    }

    function render() {
      list.innerHTML = '';
      todos.forEach((todo, i) => {
        const li = document.createElement('li');
        if (todo.done) li.classList.add('done');
        const text = document.createElement('span');
        text.textContent = todo.text;
        text.addEventListener('click', () => {
          todo.done = !todo.done;
          save();
          render();
        });
        const del = document.createElement('button');
        del.textContent = '✕';
        del.className = 'delete';
        del.addEventListener('click', () => {
          todos.splice(i, 1);
          save();
          render();
        });
        li.append(text, del);
        list.append(li);
      });
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      todos.push({ text, done: false });
      input.value = '';
      save();
      render();
    });

    render();
  </script>
</body>
</html>`,
        explain: 'Tasks are kept in an array and saved to `localStorage`, so they’re still there after a reload. `render()` redraws the list from the array; clicking a task ticks it off and ✕ deletes it. `textContent` (not `innerHTML`) keeps typed text safe.',
      },
    },
  },
  {
    task: 'a calculator web app',
    asks: ['make a calculator in html css javascript', 'build a calculator website', 'code a calculator for the browser', 'javascript calculator app'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calculator</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #1e1e2e; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .calc { background: #2a2a3c; padding: 20px; border-radius: 20px; width: 300px; }
    .display { background: #11111b; color: white; font-size: 36px; text-align: right; padding: 16px; border-radius: 12px; margin-bottom: 16px; overflow-x: auto; }
    .keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    button { font-size: 22px; padding: 18px 0; border: none; border-radius: 12px; background: #3b3b52; color: white; cursor: pointer; }
    button:hover { filter: brightness(1.2); }
    .op { background: #f5a524; }
    .wide { grid-column: span 2; }
  </style>
</head>
<body>
  <div class="calc">
    <div class="display" id="display">0</div>
    <div class="keys">
      <button data-key="C">C</button>
      <button data-key="back">⌫</button>
      <button data-key="%">%</button>
      <button class="op" data-key="/">÷</button>
      <button data-key="7">7</button>
      <button data-key="8">8</button>
      <button data-key="9">9</button>
      <button class="op" data-key="*">×</button>
      <button data-key="4">4</button>
      <button data-key="5">5</button>
      <button data-key="6">6</button>
      <button class="op" data-key="-">−</button>
      <button data-key="1">1</button>
      <button data-key="2">2</button>
      <button data-key="3">3</button>
      <button class="op" data-key="+">+</button>
      <button class="wide" data-key="0">0</button>
      <button data-key=".">.</button>
      <button class="op" data-key="=">=</button>
    </div>
  </div>
  <script>
    const display = document.getElementById('display');
    let expression = '';

    function show(text) {
      display.textContent = text || '0';
    }

    function calculate(expr) {
      // Only digits, operators, dots and brackets are allowed through.
      if (!/^[0-9+\\-*/%. ()]+$/.test(expr)) return 'Error';
      try {
        const value = Function('return (' + expr + ')')();
        return Number.isFinite(value) ? String(Math.round(value * 1e10) / 1e10) : 'Error';
      } catch {
        return 'Error';
      }
    }

    document.querySelector('.keys').addEventListener('click', (event) => {
      const key = event.target.dataset.key;
      if (!key) return;
      if (key === 'C') expression = '';
      else if (key === 'back') expression = expression.slice(0, -1);
      else if (key === '=') expression = calculate(expression);
      else expression = (expression === 'Error' ? '' : expression) + key;
      show(expression);
    });
  </script>
</body>
</html>`,
        explain: 'One click handler on the key grid reads each button’s `data-key`. The expression is only evaluated after a regular expression checks it contains nothing but numbers and operators, and the result is rounded to avoid float noise like 0.30000000000000004.',
      },
    },
  },
  {
    task: 'a stopwatch',
    asks: ['make a stopwatch website', 'build a stopwatch in javascript', 'timer with start stop and reset buttons'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stopwatch</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding-top: 80px; background: #0f172a; color: #e2e8f0; }
    .time { font-size: 72px; font-variant-numeric: tabular-nums; margin-bottom: 24px; }
    button { font-size: 18px; padding: 12px 24px; margin: 0 6px; border: none; border-radius: 999px; cursor: pointer; }
    #start { background: #22c55e; color: white; }
    #reset { background: #334155; color: white; }
  </style>
</head>
<body>
  <div class="time" id="time">00:00.00</div>
  <button id="start">Start</button>
  <button id="reset">Reset</button>
  <script>
    const timeEl = document.getElementById('time');
    const startBtn = document.getElementById('start');
    const resetBtn = document.getElementById('reset');
    let startedAt = 0;
    let elapsed = 0;
    let timer = null;

    function format(ms) {
      const minutes = String(Math.floor(ms / 60000)).padStart(2, '0');
      const seconds = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      const hundredths = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
      return minutes + ':' + seconds + '.' + hundredths;
    }

    startBtn.addEventListener('click', () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        elapsed += Date.now() - startedAt;
        startBtn.textContent = 'Start';
      } else {
        startedAt = Date.now();
        timer = setInterval(() => {
          timeEl.textContent = format(elapsed + Date.now() - startedAt);
        }, 10);
        startBtn.textContent = 'Stop';
      }
    });

    resetBtn.addEventListener('click', () => {
      clearInterval(timer);
      timer = null;
      elapsed = 0;
      timeEl.textContent = format(0);
      startBtn.textContent = 'Start';
    });
  </script>
</body>
</html>`,
        explain: 'It measures real time with `Date.now()` rather than counting ticks, so it stays accurate even if the browser delays the interval. `padStart` keeps two digits for minutes and seconds.',
      },
    },
  },
  {
    task: 'a quiz game',
    asks: ['make a quiz website', 'build a multiple choice quiz in javascript', 'code a trivia quiz for the browser', 'quiz app with a score'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quiz</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fdf6ec; display: flex; justify-content: center; padding: 40px 16px; }
    .quiz { background: white; max-width: 480px; width: 100%; padding: 28px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    .answers { display: grid; gap: 10px; margin-top: 16px; }
    .answers button { text-align: left; padding: 12px 16px; font-size: 16px; border: 2px solid #eee; border-radius: 10px; background: white; cursor: pointer; }
    .answers button.right { border-color: #22c55e; background: #ecfdf5; }
    .answers button.wrong { border-color: #ef4444; background: #fef2f2; }
    #next { margin-top: 20px; padding: 10px 20px; border: none; border-radius: 10px; background: #111827; color: white; font-size: 16px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="quiz">
    <p id="progress"></p>
    <h2 id="question"></h2>
    <div class="answers" id="answers"></div>
    <button id="next" hidden>Next</button>
  </div>
  <script>
    const questions = [
      { q: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter'], answer: 1 },
      { q: 'What does HTML stand for?', options: ['HyperText Markup Language', 'High Tech Modern Language', 'Home Tool Markup Language'], answer: 0 },
      { q: 'How many continents are there?', options: ['5', '6', '7'], answer: 2 },
    ];
    let current = 0;
    let score = 0;
    const progress = document.getElementById('progress');
    const questionEl = document.getElementById('question');
    const answersEl = document.getElementById('answers');
    const nextBtn = document.getElementById('next');

    function show() {
      const item = questions[current];
      progress.textContent = 'Question ' + (current + 1) + ' of ' + questions.length;
      questionEl.textContent = item.q;
      answersEl.innerHTML = '';
      nextBtn.hidden = true;
      item.options.forEach((option, i) => {
        const button = document.createElement('button');
        button.textContent = option;
        button.addEventListener('click', () => choose(i));
        answersEl.append(button);
      });
    }

    function choose(i) {
      const item = questions[current];
      const buttons = answersEl.querySelectorAll('button');
      buttons.forEach((b) => (b.disabled = true));
      buttons[item.answer].classList.add('right');
      if (i === item.answer) score++;
      else buttons[i].classList.add('wrong');
      nextBtn.hidden = false;
    }

    nextBtn.addEventListener('click', () => {
      current++;
      if (current < questions.length) {
        show();
      } else {
        progress.textContent = '';
        questionEl.textContent = 'You scored ' + score + ' out of ' + questions.length + '!';
        answersEl.innerHTML = '';
        nextBtn.hidden = true;
      }
    });

    show();
  </script>
</body>
</html>`,
        explain: 'Questions live in an array of objects. `show()` builds the answer buttons for the current question; `choose()` marks right and wrong answers, disables the buttons and counts the score. Add more questions to the array to grow the quiz.',
      },
    },
  },
  {
    task: 'a dark mode toggle',
    asks: ['add a dark mode toggle to my website', 'how do i make dark mode with a button', 'dark and light theme switch in javascript'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dark Mode</title>
  <style>
    :root { --bg: #ffffff; --text: #1f2937; --card: #f3f4f6; }
    body.dark { --bg: #111827; --text: #f9fafb; --card: #1f2937; }
    body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 40px; transition: background 0.3s, color 0.3s; }
    .card { background: var(--card); padding: 20px; border-radius: 12px; max-width: 400px; }
    button { padding: 10px 16px; border-radius: 8px; border: none; cursor: pointer; }
  </style>
</head>
<body>
  <button id="toggle">🌙 Dark mode</button>
  <div class="card">
    <h1>Hello!</h1>
    <p>This page remembers whether you like it dark or light.</p>
  </div>
  <script>
    const toggle = document.getElementById('toggle');

    function apply(dark) {
      document.body.classList.toggle('dark', dark);
      toggle.textContent = dark ? '☀️ Light mode' : '🌙 Dark mode';
      localStorage.setItem('dark', dark ? '1' : '0');
    }

    toggle.addEventListener('click', () => apply(!document.body.classList.contains('dark')));
    apply(localStorage.getItem('dark') === '1');
  </script>
</body>
</html>`,
        explain: 'Colours are CSS variables; the `dark` class on `<body>` swaps them all at once. The choice is saved in `localStorage` so it’s remembered next visit.',
      },
    },
  },
  {
    task: 'form validation',
    asks: ['validate a form with javascript', 'check an email and password before submitting', 'sign up form with validation', 'show an error if a form field is empty'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign Up</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #eef2ff; display: flex; justify-content: center; padding: 60px 16px; }
    form { background: white; padding: 28px; border-radius: 14px; width: 100%; max-width: 360px; display: grid; gap: 6px; }
    label { font-weight: 600; margin-top: 10px; }
    input { padding: 10px; border: 1px solid #c7cbe0; border-radius: 8px; font-size: 16px; }
    input.invalid { border-color: #e11d48; }
    .error { color: #e11d48; font-size: 14px; min-height: 18px; }
    button { margin-top: 16px; padding: 12px; border: none; border-radius: 8px; background: #4338ca; color: white; font-size: 16px; cursor: pointer; }
    .success { color: #15803d; font-weight: 600; }
  </style>
</head>
<body>
  <form id="signup" novalidate>
    <h2>Create an account</h2>
    <label for="email">Email</label>
    <input id="email" type="email">
    <div class="error" id="email-error"></div>
    <label for="password">Password</label>
    <input id="password" type="password">
    <div class="error" id="password-error"></div>
    <button type="submit">Sign up</button>
    <p class="success" id="message"></p>
  </form>
  <script>
    const form = document.getElementById('signup');

    function check(id, test, message) {
      const input = document.getElementById(id);
      const ok = test(input.value.trim());
      input.classList.toggle('invalid', !ok);
      document.getElementById(id + '-error').textContent = ok ? '' : message;
      return ok;
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const emailOk = check('email', (v) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v), 'Enter a valid email address.');
      const passwordOk = check('password', (v) => v.length >= 8, 'Use at least 8 characters.');
      document.getElementById('message').textContent = emailOk && passwordOk ? 'Account created! 🎉' : '';
    });
  </script>
</body>
</html>`,
        explain: '`novalidate` turns off the browser’s own pop-ups so you control the messages. `check()` tests one field, outlines it in red and shows a message if it fails; the form only “succeeds” when every check passes. Always validate again on the server, too.',
      },
    },
  },
  {
    task: 'an image slider',
    asks: ['make an image slider', 'carousel in javascript', 'slideshow with next and previous buttons'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Slider</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; padding: 40px 16px; }
    .slider { position: relative; width: 100%; max-width: 600px; overflow: hidden; border-radius: 16px; }
    .track { display: flex; transition: transform 0.5s ease; }
    .slide { min-width: 100%; height: 320px; display: flex; align-items: center; justify-content: center; font-size: 48px; color: white; }
    .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0, 0, 0, 0.4); color: white; border: none; font-size: 28px; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; }
    .prev { left: 12px; }
    .next { right: 12px; }
    .dots { position: absolute; bottom: 12px; width: 100%; text-align: center; }
    .dot { display: inline-block; width: 10px; height: 10px; margin: 0 4px; border-radius: 50%; background: rgba(255, 255, 255, 0.5); cursor: pointer; }
    .dot.active { background: white; }
  </style>
</head>
<body>
  <div class="slider">
    <div class="track" id="track">
      <div class="slide" style="background: #ef4444">🌅</div>
      <div class="slide" style="background: #3b82f6">🌊</div>
      <div class="slide" style="background: #10b981">🌲</div>
    </div>
    <button class="nav prev" id="prev">‹</button>
    <button class="nav next" id="next">›</button>
    <div class="dots" id="dots"></div>
  </div>
  <script>
    const track = document.getElementById('track');
    const slides = track.children.length;
    const dots = document.getElementById('dots');
    let index = 0;

    for (let i = 0; i < slides; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.addEventListener('click', () => go(i));
      dots.append(dot);
    }

    function go(i) {
      index = (i + slides) % slides;
      track.style.transform = 'translateX(' + (-100 * index) + '%)';
      [...dots.children].forEach((d, n) => d.classList.toggle('active', n === index));
    }

    document.getElementById('prev').addEventListener('click', () => go(index - 1));
    document.getElementById('next').addEventListener('click', () => go(index + 1));
    setInterval(() => go(index + 1), 5000);
    go(0);
  </script>
</body>
</html>`,
        explain: 'All slides sit side by side in a flex row; moving to a slide slides the row left with `translateX` (animated by the CSS transition). `(i + slides) % slides` wraps around at both ends, and it advances by itself every 5 seconds. Replace the coloured slides with `<img>` tags for real photos.',
      },
    },
  },
  {
    task: 'a snake game',
    asks: ['make a snake game in javascript', 'code snake for the browser', 'make a game with html canvas', 'build a simple arcade game'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Snake</title>
  <style>
    body { background: #111; color: #eee; font-family: system-ui, sans-serif; text-align: center; }
    canvas { background: #1b1b1b; border: 2px solid #333; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Snake</h1>
  <p>Score: <span id="score">0</span> · arrow keys to move</p>
  <canvas id="game" width="400" height="400"></canvas>
  <script>
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const size = 20;
    const cells = canvas.width / size;
    let snake = [{ x: 10, y: 10 }];
    let dir = { x: 1, y: 0 };
    let food = randomCell();
    let score = 0;

    function randomCell() {
      return { x: Math.floor(Math.random() * cells), y: Math.floor(Math.random() * cells) };
    }

    document.addEventListener('keydown', (e) => {
      const turns = {
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
      };
      const next = turns[e.key];
      // Can't turn straight back into yourself.
      if (next && (next.x !== -dir.x || next.y !== -dir.y)) dir = next;
    });

    function step() {
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      const hitWall = head.x < 0 || head.y < 0 || head.x >= cells || head.y >= cells;
      const hitSelf = snake.some((part) => part.x === head.x && part.y === head.y);
      if (hitWall || hitSelf) {
        alert('Game over! Score: ' + score);
        snake = [{ x: 10, y: 10 }];
        dir = { x: 1, y: 0 };
        score = 0;
        document.getElementById('score').textContent = score;
        return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score++;
        document.getElementById('score').textContent = score;
        food = randomCell();
      } else {
        snake.pop();
      }
      draw();
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(food.x * size, food.y * size, size - 2, size - 2);
      ctx.fillStyle = '#22c55e';
      for (const part of snake) ctx.fillRect(part.x * size, part.y * size, size - 2, size - 2);
    }

    setInterval(step, 120);
  </script>
</body>
</html>`,
        explain: 'The board is a grid of 20-pixel cells on a `<canvas>`. Each tick adds a new head in the current direction and removes the tail — unless the snake just ate, which is how it grows. Hitting a wall or itself ends the game.',
      },
    },
  },
  {
    task: 'a tip calculator',
    asks: ['make a tip calculator', 'split the bill calculator website', 'calculator that updates as you type'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tip Calculator</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #ecfeff; display: flex; justify-content: center; padding: 50px 16px; }
    .card { background: white; padding: 28px; border-radius: 16px; width: 100%; max-width: 340px; display: grid; gap: 10px; }
    input { padding: 10px; font-size: 18px; border: 1px solid #cde; border-radius: 8px; }
    .total { font-size: 28px; font-weight: 700; color: #0e7490; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Tip Calculator</h2>
    <label>Bill <input id="bill" type="number" value="50" min="0"></label>
    <label>Tip % <input id="tip" type="number" value="15" min="0"></label>
    <label>People <input id="people" type="number" value="2" min="1"></label>
    <div>Each person pays</div>
    <div class="total" id="total"></div>
  </div>
  <script>
    const fields = ['bill', 'tip', 'people'].map((id) => document.getElementById(id));

    function update() {
      const [bill, tip, people] = fields.map((f) => Number(f.value) || 0);
      const each = people > 0 ? (bill * (1 + tip / 100)) / people : 0;
      document.getElementById('total').textContent = '$' + each.toFixed(2);
    }

    fields.forEach((f) => f.addEventListener('input', update));
    update();
  </script>
</body>
</html>`,
        explain: 'The `input` event fires on every keystroke, so the total updates live. `toFixed(2)` shows it as money.',
      },
    },
  },
  {
    task: 'fetch and show data on a page',
    asks: ['show api data on a web page', 'fetch json and display it in html', 'load data with fetch and make a list', 'display users from an api'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Users</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
    .user { padding: 14px; border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 10px; }
    .user small { color: #6b7280; }
  </style>
</head>
<body>
  <h1>Users</h1>
  <p id="status">Loading…</p>
  <div id="users"></div>
  <script>
    async function loadUsers() {
      const status = document.getElementById('status');
      try {
        const response = await fetch('https://jsonplaceholder.typicode.com/users');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const users = await response.json();
        const container = document.getElementById('users');
        for (const user of users) {
          const div = document.createElement('div');
          div.className = 'user';
          const name = document.createElement('strong');
          name.textContent = user.name;
          const email = document.createElement('small');
          email.textContent = ' ' + user.email;
          div.append(name, email);
          container.append(div);
        }
        status.textContent = users.length + ' users';
      } catch (err) {
        status.textContent = 'Could not load users: ' + err.message;
      }
    }

    loadUsers();
  </script>
</body>
</html>`,
        explain: '`fetch` gets the JSON, then each user becomes a small card built with `createElement`. The `try … catch` shows a message instead of failing silently if the network or server has a problem.',
      },
    },
  },
];
