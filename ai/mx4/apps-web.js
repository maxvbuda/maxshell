'use strict';

// Small web apps for mx4's training data — the everyday pieces of web
// development — each a complete page, themed like the games, played by
// gamecheck before use. Builders return { css, body, js, notes }.

const { THEMES, FONTS } = require('./games-web');

function page({ title, t, font, css = '', body, js }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 16px;
      background: ${t.bg};
      color: ${t.fg};
      font-family: ${font};
    }
    h1 { margin: 0 0 16px; }
    .card { width: min(100%, 420px); background: ${t.panel}; border-radius: 14px; padding: 20px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2); }
    button { font: inherit; padding: 10px 16px; border: none; border-radius: 8px; background: ${t.accent}; color: ${t.bg}; cursor: pointer; }
    button:hover { filter: brightness(1.1); }
    input, select, textarea { font: inherit; padding: 10px; border-radius: 8px; border: 1px solid ${t.muted}; background: ${t.bg}; color: ${t.fg}; }
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

const APPS = {
  todo: {
    names: ['a to-do list', 'a todo app', 'a to do list app', 'a task list'], titles: ['To-Do List', 'My Tasks', 'Todo'],
    build: (s, r) => {
      const save = r.chance(0.6);
      return {
        css: `    form { display: flex; gap: 8px; margin-bottom: 12px; }
    form input { flex: 1; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid ${s.t.bg}; }
    li span { flex: 1; cursor: pointer; }
    li.done span { text-decoration: line-through; opacity: 0.5; }
    li button { background: none; color: ${s.t.accent2}; padding: 4px 8px; }`,
        body: `  <h1>${s.title}</h1>
  <div class="card">
    <form id="form">
      <input id="text" placeholder="What needs doing?" autocomplete="off">
      <button type="submit">Add</button>
    </form>
    <ul id="list"></ul>
    <p id="left"></p>
  </div>`,
        js: `    const form = document.getElementById('form');
    const input = document.getElementById('text');
    const list = document.getElementById('list');
    const left = document.getElementById('left');

    let todos = ${save ? "JSON.parse(localStorage.getItem('todos') || '[]')" : '[]'};

    function render() {
      list.innerHTML = '';
      todos.forEach((todo, i) => {
        const item = document.createElement('li');
        if (todo.done) item.classList.add('done');
        const text = document.createElement('span');
        text.textContent = todo.text;
        text.addEventListener('click', () => {
          todo.done = !todo.done;
          update();
        });
        const remove = document.createElement('button');
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          todos.splice(i, 1);
          update();
        });
        item.append(text, remove);
        list.appendChild(item);
      });
      const remaining = todos.filter((todo) => !todo.done).length;
      left.textContent = remaining + (remaining === 1 ? ' task' : ' tasks') + ' left';
    }

    function update() {
${save ? "      localStorage.setItem('todos', JSON.stringify(todos));\n" : ''}      render();
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      todos.push({ text, done: false });
      input.value = '';
      update();
    });

    render();`,
        notes: ['**How it works:** the tasks live in the `todos` array; every change updates the array and `render()` rebuilds the list from it. Click a task to tick it off, ✕ to delete it.' + (save ? ' The list is saved in `localStorage` as JSON, so it’s still there after a reload.' : ''), '**Make it yours:** add a “clear completed” button with `todos = todos.filter((t) => !t.done)`.'],
      };
    },
  },
  calculator: {
    names: ['a calculator', 'a calculator app', 'a simple calculator'], titles: ['Calculator', 'Calc'],
    build: (s) => ({
      css: `    #display { width: 100%; font-size: 2rem; text-align: right; margin-bottom: 12px; }
    .keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .keys button { font-size: 1.3rem; padding: 16px 0; background: ${s.t.bg}; color: ${s.t.fg}; }
    .keys .op { background: ${s.t.accent}; color: ${s.t.bg}; }
    .keys .wide { grid-column: span 2; }`,
      body: `  <h1>${s.title}</h1>
  <div class="card">
    <input id="display" value="0" readonly>
    <div class="keys" id="keys">
      <button data-key="C">C</button><button data-key="(">(</button><button data-key=")">)</button><button class="op" data-key="/">÷</button>
      <button data-key="7">7</button><button data-key="8">8</button><button data-key="9">9</button><button class="op" data-key="*">×</button>
      <button data-key="4">4</button><button data-key="5">5</button><button data-key="6">6</button><button class="op" data-key="-">−</button>
      <button data-key="1">1</button><button data-key="2">2</button><button data-key="3">3</button><button class="op" data-key="+">+</button>
      <button class="wide" data-key="0">0</button><button data-key=".">.</button><button class="op" data-key="=">=</button>
    </div>
  </div>`,
      js: `    const display = document.getElementById('display');
    let expression = '';

    // Only digits, operators, brackets and dots get here, so the
    // expression is safe to evaluate.
    function calculate(text) {
      if (!/^[0-9+\\-*/(). ]+$/.test(text)) return 'Error';
      try {
        const value = Function('"use strict"; return (' + text + ')')();
        return Number.isFinite(value) ? String(Math.round(value * 1e10) / 1e10) : 'Error';
      } catch {
        return 'Error';
      }
    }

    function press(key) {
      if (key === 'C') expression = '';
      else if (key === '=') expression = calculate(expression);
      else expression = (expression === 'Error' ? '' : expression) + key;
      display.value = expression || '0';
    }

    for (const button of document.querySelectorAll('#keys button')) {
      button.addEventListener('click', () => press(button.dataset.key));
    }
    document.addEventListener('keydown', (event) => {
      if (/^[0-9+\\-*/().]$/.test(event.key)) press(event.key);
      else if (event.key === 'Enter') press('=');
      else if (event.key === 'Escape' || event.key === 'Backspace') press('C');
    });`,
      notes: ['**How it works:** each button stores what it types in `data-key`. The display builds up an expression; = checks it contains only numbers and operators, then works it out. You can type with the keyboard too (Enter for =, Esc to clear).', '**Make it yours:** add a % or √ key by giving it a `data-key` and handling it in `press()`.'],
    }),
  },
  stopwatch: {
    names: ['a stopwatch', 'a stopwatch app', 'a lap timer'], titles: ['Stopwatch', 'Lap Timer'],
    build: (s) => ({
      css: `    #time { font-size: 3rem; font-variant-numeric: tabular-nums; text-align: center; margin: 10px 0 16px; }
    .row { display: flex; gap: 8px; justify-content: center; }
    ol { padding-left: 24px; color: ${s.t.muted}; }`,
      body: `  <h1>${s.title}</h1>
  <div class="card">
    <div id="time">00:00.00</div>
    <div class="row">
      <button id="start">Start</button>
      <button id="lap">Lap</button>
      <button id="reset">Reset</button>
    </div>
    <ol id="laps"></ol>
  </div>`,
      js: `    const timeEl = document.getElementById('time');
    const startButton = document.getElementById('start');
    const laps = document.getElementById('laps');

    let elapsed = 0; // milliseconds before the current run
    let startedAt = null;
    let timer = null;

    function now() {
      return elapsed + (startedAt === null ? 0 : Date.now() - startedAt);
    }

    function format(ms) {
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      const hundredths = Math.floor((ms % 1000) / 10);
      return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + String(hundredths).padStart(2, '0');
    }

    function show() {
      timeEl.textContent = format(now());
    }

    startButton.addEventListener('click', () => {
      if (startedAt === null) {
        startedAt = Date.now();
        timer = setInterval(show, 30);
        startButton.textContent = 'Stop';
      } else {
        elapsed = now();
        startedAt = null;
        clearInterval(timer);
        startButton.textContent = 'Start';
      }
    });

    document.getElementById('lap').addEventListener('click', () => {
      if (startedAt === null) return;
      const item = document.createElement('li');
      item.textContent = format(now());
      laps.appendChild(item);
    });

    document.getElementById('reset').addEventListener('click', () => {
      clearInterval(timer);
      elapsed = 0;
      startedAt = null;
      startButton.textContent = 'Start';
      laps.innerHTML = '';
      show();
    });`,
      notes: ['**How it works:** instead of counting ticks (which drift), it remembers when you pressed Start and subtracts that from `Date.now()`. `setInterval` just refreshes the display; `padStart` keeps the digits lined up.', '**Make it yours:** make it a countdown by starting from a time and subtracting.'],
    }),
  },
  tabs: {
    names: ['tabs', 'a tabs component', 'tabbed content', 'tabs in html and javascript'], titles: ['Tabs', 'Tabbed Panel'],
    build: (s) => ({
      css: `    .tabs { display: flex; gap: 4px; border-bottom: 2px solid ${s.t.bg}; }
    .tab { background: none; color: ${s.t.muted}; border-radius: 8px 8px 0 0; }
    .tab.active { background: ${s.t.accent}; color: ${s.t.bg}; }
    .panel { padding: 16px 4px; }
    .panel[hidden] { display: none; }`,
      body: `  <h1>${s.title}</h1>
  <div class="card">
    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="one">Overview</button>
      <button class="tab" data-tab="two">Features</button>
      <button class="tab" data-tab="three">Pricing</button>
    </div>
    <div class="panel" id="one">A quick overview of what this does.</div>
    <div class="panel" id="two" hidden>Fast, simple and free.</div>
    <div class="panel" id="three" hidden>Everything is included.</div>
  </div>`,
      js: `    const tabs = document.querySelectorAll('.tab');

    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        for (const other of tabs) {
          other.classList.toggle('active', other === tab);
          document.getElementById(other.dataset.tab).hidden = other !== tab;
        }
      });
    }`,
      notes: ['**How it works:** each tab button names its panel in `data-tab`. Clicking one marks it active and hides every panel except its own (`hidden` is a built-in HTML attribute).', '**Make it yours:** add a tab by adding a button and a panel with matching names.'],
    }),
  },
  modal: {
    names: ['a modal', 'a popup', 'a modal dialog', 'a popup window'], titles: ['Modal Demo', 'Popup'],
    build: (s) => ({
      css: `    .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; }
    .overlay[hidden] { display: none; }
    .modal { width: min(90vw, 380px); background: ${s.t.panel}; border-radius: 14px; padding: 24px; }
    .modal h2 { margin-top: 0; }`,
      body: `  <h1>${s.title}</h1>
  <button id="open">Open the popup</button>
  <div class="overlay" id="overlay" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">Hello! 👋</h2>
      <p>This is a modal. Click outside it, press Esc, or use the button to close it.</p>
      <button id="close">Close</button>
    </div>
  </div>`,
      js: `    const overlay = document.getElementById('overlay');

    function open() { overlay.hidden = false; }
    function close() { overlay.hidden = true; }

    document.getElementById('open').addEventListener('click', open);
    document.getElementById('close').addEventListener('click', close);
    // A click on the dark background (not the box itself) closes it.
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });`,
      notes: ['**How it works:** the overlay covers the page (`position: fixed; inset: 0`) and centres the box with flexbox. Showing and hiding is just the `hidden` attribute. Clicks on the overlay itself — not the box — close it, and so does Esc.', '**Tip:** modern browsers also have a built-in `<dialog>` element with `showModal()`.'],
    }),
  },
  form: {
    names: ['a sign up form with validation', 'form validation', 'a contact form that checks the input', 'a registration form'], titles: ['Sign Up', 'Create an Account', 'Join Us'],
    build: (s) => ({
      css: `    form { display: grid; gap: 6px; }
    label { margin-top: 8px; font-weight: 600; }
    .error { color: ${s.t.accent2}; font-size: 0.85rem; min-height: 1.1em; }
    input.bad { border-color: ${s.t.accent2}; }
    #done { color: ${s.t.accent}; }`,
      body: `  <h1>${s.title}</h1>
  <div class="card">
    <form id="form" novalidate>
      <label for="name">Name</label>
      <input id="name">
      <span class="error" id="name-error"></span>
      <label for="email">Email</label>
      <input id="email" type="email">
      <span class="error" id="email-error"></span>
      <label for="password">Password</label>
      <input id="password" type="password">
      <span class="error" id="password-error"></span>
      <button type="submit">Sign up</button>
      <p id="done" hidden>Thanks for signing up! 🎉</p>
    </form>
  </div>`,
      js: `    const form = document.getElementById('form');

    const RULES = {
      name: (v) => (v.trim().length >= 2 ? '' : 'Please enter your name.'),
      email: (v) => (/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(v) ? '' : 'That doesn’t look like an email address.'),
      password: (v) => (v.length >= 8 ? '' : 'Use at least 8 characters.'),
    };

    function check(field) {
      const input = document.getElementById(field);
      const message = RULES[field](input.value);
      document.getElementById(field + '-error').textContent = message;
      input.classList.toggle('bad', Boolean(message));
      return !message;
    }

    for (const field of Object.keys(RULES)) {
      document.getElementById(field).addEventListener('input', () => check(field));
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const ok = Object.keys(RULES).map(check).every(Boolean);
      document.getElementById('done').hidden = !ok;
      if (ok) form.reset();
    });`,
      notes: ['**How it works:** `RULES` has one check per field that returns an error message or an empty string. Fields are re-checked as you type (`input` event), and on submit every rule runs — the form only succeeds when all pass. `novalidate` turns off the browser’s own pop-ups so ours show instead.', '**Remember:** always check again on the server — anyone can bypass JavaScript.'],
    }),
  },
  darkmode: {
    names: ['a dark mode toggle', 'a light and dark theme switch', 'dark mode'], titles: ['Dark Mode', 'Theme Switcher'],
    build: (s) => ({
      css: `    body.light { background: #f8fafc; color: #0f172a; }
    body.light .card { background: #ffffff; }
    body { transition: background 0.3s, color 0.3s; }`,
      body: `  <h1>${s.title}</h1>
  <div class="card">
    <p>Press the button to switch themes. Your choice is remembered.</p>
    <button id="toggle">☀️ Light mode</button>
  </div>`,
      js: `    const toggle = document.getElementById('toggle');

    function apply(light) {
      document.body.classList.toggle('light', light);
      toggle.textContent = light ? '🌙 Dark mode' : '☀️ Light mode';
      localStorage.setItem('theme', light ? 'light' : 'dark');
    }

    toggle.addEventListener('click', () => apply(!document.body.classList.contains('light')));
    apply(localStorage.getItem('theme') === 'light');`,
      notes: ['**How it works:** the light colours are CSS rules under `body.light`, so switching is just toggling one class. The choice is saved in `localStorage` and applied when the page loads.', '**Tip:** `window.matchMedia(\'(prefers-color-scheme: dark)\').matches` tells you the system’s setting, for a smart default.'],
    }),
  },
  notes: {
    names: ['a notes app', 'a note taking app', 'a sticky notes app'], titles: ['Notes', 'Quick Notes', 'My Notes'],
    build: (s) => ({
      css: `    textarea { width: 100%; min-height: 80px; resize: vertical; }
    #notes { display: grid; gap: 10px; margin-top: 12px; }
    .note { background: ${s.t.bg}; border-radius: 10px; padding: 12px; white-space: pre-wrap; position: relative; }
    .note button { position: absolute; top: 6px; right: 6px; background: none; color: ${s.t.accent2}; padding: 2px 6px; }
    .note small { display: block; color: ${s.t.muted}; margin-top: 6px; }`,
      body: `  <h1>${s.title}</h1>
  <div class="card">
    <textarea id="text" placeholder="Write a note…"></textarea>
    <button id="add">Save note</button>
    <div id="notes"></div>
  </div>`,
      js: `    const text = document.getElementById('text');
    const list = document.getElementById('notes');
    let notes = JSON.parse(localStorage.getItem('notes') || '[]');

    function save() {
      localStorage.setItem('notes', JSON.stringify(notes));
      render();
    }

    function render() {
      list.innerHTML = '';
      notes.forEach((note, i) => {
        const box = document.createElement('div');
        box.className = 'note';
        box.textContent = note.text;
        const when = document.createElement('small');
        when.textContent = new Date(note.at).toLocaleString();
        const remove = document.createElement('button');
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          notes.splice(i, 1);
          save();
        });
        box.append(when, remove);
        list.appendChild(box);
      });
    }

    document.getElementById('add').addEventListener('click', () => {
      const value = text.value.trim();
      if (!value) return;
      notes.unshift({ text: value, at: Date.now() });
      text.value = '';
      save();
    });

    render();`,
      notes: ['**How it works:** notes are objects with their text and a timestamp, kept newest-first in an array that’s saved to `localStorage` as JSON after every change. Using `textContent` (not `innerHTML`) means anything typed is shown as text, never run as HTML.', '**Make it yours:** add a search box that filters `notes` before rendering.'],
    }),
  },
  quiz: {
    names: ['a quiz app', 'a multiple choice quiz', 'a trivia quiz website'], titles: ['Quiz Time', 'Trivia', 'Quick Quiz'],
    build: (s, r) => {
      const qs = r.pick([
        [['What is the largest planet?', ['Mars', 'Jupiter', 'Venus'], 1], ['How many continents are there?', ['5', '6', '7'], 2], ['What do bees make?', ['Honey', 'Milk', 'Silk'], 0]],
        [['What does CSS style?', ['Databases', 'Web pages', 'Servers'], 1], ['Which keyword declares a constant in JavaScript?', ['let', 'var', 'const'], 2], ['What does HTML stand for?', ['HyperText Markup Language', 'High Tech Modern Language', 'Home Tool Markup Language'], 0]],
      ]);
      return {
        css: `    #choices { display: grid; gap: 8px; margin: 12px 0; }
    #choices button { background: ${s.t.bg}; color: ${s.t.fg}; text-align: left; }
    #choices button.right { background: #16a34a; color: #fff; }
    #choices button.wrong { background: #dc2626; color: #fff; }`,
        body: `  <h1>${s.title}</h1>
  <div class="card">
    <p id="progress"></p>
    <h2 id="question"></h2>
    <div id="choices"></div>
    <button id="next" hidden>Next</button>
  </div>`,
        js: `    const QUESTIONS = [
${qs.map(([q, c, a]) => `      { q: ${JSON.stringify(q)}, choices: ${JSON.stringify(c)}, answer: ${a} },`).join('\n')}
    ];
    const question = document.getElementById('question');
    const choices = document.getElementById('choices');
    const progress = document.getElementById('progress');
    const next = document.getElementById('next');
    let index = 0;
    let score = 0;

    function show() {
      const item = QUESTIONS[index];
      progress.textContent = 'Question ' + (index + 1) + ' of ' + QUESTIONS.length;
      question.textContent = item.q;
      choices.innerHTML = '';
      next.hidden = true;
      item.choices.forEach((choice, i) => {
        const button = document.createElement('button');
        button.textContent = choice;
        button.addEventListener('click', () => answer(i, button));
        choices.appendChild(button);
      });
    }

    function answer(i, button) {
      if (!next.hidden) return; // already answered
      const right = i === QUESTIONS[index].answer;
      if (right) score++;
      button.classList.add(right ? 'right' : 'wrong');
      choices.children[QUESTIONS[index].answer].classList.add('right');
      next.hidden = false;
    }

    next.addEventListener('click', () => {
      index++;
      if (index < QUESTIONS.length) return show();
      question.textContent = 'You scored ' + score + ' out of ' + QUESTIONS.length + '!';
      choices.innerHTML = '';
      progress.textContent = '';
      next.hidden = true;
    });

    show();`,
        notes: ['**How it works:** each question is an object with its choices and the index of the right one. `show()` builds a button per choice; answering colours your pick and reveals the right answer, then Next moves on.', '**Make it yours:** add questions to `QUESTIONS` — nothing else needs to change.'],
      };
    },
  },
  clock: {
    names: ['a digital clock', 'a clock', 'a live clock'], titles: ['Clock', 'Digital Clock'],
    build: (s, r) => {
      const h24 = r.chance(0.5);
      return {
        css: `    #time { font-size: 4rem; font-variant-numeric: tabular-nums; text-align: center; }
    #date { text-align: center; color: ${s.t.muted}; }`,
        body: `  <h1>${s.title}</h1>
  <div class="card">
    <div id="time"></div>
    <div id="date"></div>
  </div>`,
        js: `    const timeEl = document.getElementById('time');
    const dateEl = document.getElementById('date');

    function tick() {
      const now = new Date();
      timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: ${!h24} });
      dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    tick();
    setInterval(tick, 1000);`,
        notes: [`**How it works:** \`tick()\` reads the current time with \`new Date()\` and formats it with \`toLocaleTimeString\` (${h24 ? '24-hour' : '12-hour'}); \`setInterval\` runs it every second.`, '**Make it yours:** set `hour12` the other way, or use `timeZone: \'Asia/Tokyo\'` in the options for another city.'],
      };
    },
  },
  tipcalc: {
    names: ['a tip calculator', 'a bill splitter', 'a tip calculator app'], titles: ['Tip Calculator', 'Split the Bill'],
    build: (s) => ({
      css: `    label { display: block; margin: 10px 0 4px; }
    input { width: 100%; }
    .result { display: flex; justify-content: space-between; font-size: 1.2rem; margin-top: 12px; }`,
      body: `  <h1>${s.title}</h1>
  <div class="card">
    <label for="bill">Bill</label>
    <input id="bill" type="number" min="0" step="0.01" value="50">
    <label for="tip">Tip: <b id="tip-value">15</b>%</label>
    <input id="tip" type="range" min="0" max="30" value="15">
    <label for="people">People</label>
    <input id="people" type="number" min="1" value="2">
    <div class="result"><span>Tip</span><b id="tip-total"></b></div>
    <div class="result"><span>Each person pays</span><b id="each"></b></div>
  </div>`,
      js: `    const fields = ['bill', 'tip', 'people'].map((id) => document.getElementById(id));
    const money = (n) => '$' + n.toFixed(2);

    function update() {
      const [bill, tip, people] = fields.map((field) => Number(field.value) || 0);
      const tipAmount = (bill * tip) / 100;
      document.getElementById('tip-value').textContent = tip;
      document.getElementById('tip-total').textContent = money(tipAmount);
      document.getElementById('each').textContent = money((bill + tipAmount) / Math.max(1, people));
    }

    for (const field of fields) field.addEventListener('input', update);
    update();`,
      notes: ['**How it works:** every field calls `update()` as you type; it reads the three numbers, works out the tip and the share, and formats money with `toFixed(2)`. `Math.max(1, people)` avoids dividing by zero.', '**Make it yours:** add buttons for common tips (10, 15, 20%) that set the slider’s value and call `update()`.'],
    }),
  },
};

const ASKS = [
  (g) => `make ${g}`, (g) => `build ${g} in html css and javascript`, (g) => `can you make ${g}?`, (g) => `code ${g}`,
  (g) => `how do i make ${g} with javascript`, (g) => `write ${g} for my website`, (g) => `create ${g}`, (g) => `i want ${g} on my web page`,
  (g) => `make me ${g} in one html file`, (g) => `show me how to build ${g}`,
];
const INTROS = [
  (title) => `Here’s ${title} in one HTML file — save it as \`index.html\` and open it in your browser.`,
  () => 'Sure! Everything — HTML, CSS and JavaScript — is in one file:',
  () => 'Here you go. Save this as an `.html` file and open it:',
];

function appConversation(rand, kind = null) {
  const r = { pick: (l) => l[Math.floor(rand() * l.length)], chance: (p) => rand() < p };
  const k = kind || r.pick(Object.keys(APPS));
  const app = APPS[k];
  const t = r.pick(THEMES);
  const s = { t, font: r.pick(FONTS), title: r.pick(app.titles) };
  const built = app.build(s, r);
  const html = page({ title: s.title, t, font: s.font, css: built.css, body: built.body, js: built.js });
  const request = r.pick(ASKS)(r.pick(app.names));
  const reply = `${r.pick(INTROS)(s.title)}\n\n\`\`\`html\n${html}\n\`\`\`\n\n${built.notes.join('\n\n')}`;
  return { kind: k, request, reply, html };
}

if (require.main === module) {
  const { playCheck } = require('./gamecheck');
  let seed = 3;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let bad = 0;
  const seen = new Set();
  const n = Number(process.argv[2]) || 120;
  for (let i = 0; i < n; i++) {
    const c = appConversation(rand);
    seen.add(c.kind);
    const problem = playCheck(c.html);
    if (problem) { bad++; console.log(`✗ ${c.kind}: ${problem}`); }
  }
  console.log(`${n} apps (${seen.size} kinds) played, ${bad} failed`);
}

module.exports = { appConversation, APPS };
