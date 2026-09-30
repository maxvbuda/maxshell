'use strict';

// "How does X work?" — programming and web concepts, each explained with a
// small example that validate.js checks (runs it, or checks the HTML/CSS).

const frag = { fragment: true };

module.exports = [
  // --- CSS layout ----------------------------------------------------------------
  {
    task: 'center a div',
    asks: ['how do i center a div', 'center something in css', 'center an element horizontally and vertically', 'css center text and boxes', 'how to center a div in css'],
    impls: {
      css: {
        code: `.parent {
  display: flex;
  justify-content: center; /* left-right */
  align-items: center;     /* top-bottom */
  min-height: 100vh;       /* give it height to center within */
}`,
        explain: 'Make the parent a flex container: `justify-content` centers along the row and `align-items` centers across it. The parent needs a height (here the full screen) for vertical centering to show. `display: grid; place-items: center;` does the same in one line.',
      },
    },
  },
  {
    task: 'use flexbox',
    asks: ['how does flexbox work', 'explain css flexbox', 'put items in a row with css', 'flexbox tutorial', 'space items out evenly in a row'],
    impls: {
      css: {
        code: `.row {
  display: flex;
  gap: 16px;                       /* space between items */
  justify-content: space-between;  /* spread them across the row */
  align-items: center;             /* line them up vertically */
  flex-wrap: wrap;                 /* wrap to a new line if they don't fit */
}

.row .grow {
  flex: 1; /* this item takes the leftover space */
}`,
        explain: '`display: flex` lays children out in a row. `justify-content` controls spacing along the row (`flex-start`, `center`, `space-between`…), `align-items` lines them up across it, `gap` adds space between them, and `flex: 1` lets an item stretch. Use `flex-direction: column` to stack them instead.',
      },
    },
  },
  {
    task: 'use CSS grid',
    asks: ['how does css grid work', 'make a grid layout', 'three columns in css', 'responsive grid of cards', 'css grid tutorial'],
    impls: {
      css: {
        code: `.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 24px;
}

.layout {
  display: grid;
  grid-template-columns: 240px 1fr;  /* sidebar + main */
  grid-template-rows: auto 1fr auto; /* header, content, footer */
  min-height: 100vh;
}`,
        explain: '`grid-template-columns` defines the columns. `repeat(auto-fit, minmax(220px, 1fr))` fits as many 220px-or-wider columns as the screen allows — a responsive card grid with no media queries. For a page layout, list the column and row sizes directly; `1fr` means “the rest of the space”.',
      },
    },
  },
  {
    task: 'make a website responsive',
    asks: ['how do i make my website work on phones', 'media queries in css', 'make a site responsive', 'responsive design tips', 'my website looks bad on mobile'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Responsive</title>
  <style>
    .columns { display: flex; gap: 20px; }
    .columns > div { flex: 1; padding: 20px; background: #eef; }
    img { max-width: 100%; height: auto; }

    /* Screens 700px wide or less: stack the columns. */
    @media (max-width: 700px) {
      .columns { flex-direction: column; }
      h1 { font-size: 1.6rem; }
    }
  </style>
</head>
<body>
  <h1>Resize the window</h1>
  <div class="columns">
    <div>One</div>
    <div>Two</div>
    <div>Three</div>
  </div>
</body>
</html>`,
        explain: 'Three things: the viewport `<meta>` tag (without it phones pretend to be a desktop), flexible sizes (`max-width: 100%` on images, `flex`/`grid` instead of fixed widths), and `@media` queries that change the layout on small screens — here the columns stack below 700px.',
      },
    },
  },
  {
    task: 'position elements',
    asks: ['css position absolute vs relative', 'how does position absolute work', 'put a badge in the corner of a card', 'make a sticky header', 'what does z-index do'],
    impls: {
      css: {
        code: `.card {
  position: relative; /* the badge is placed relative to this */
}

.badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2; /* above other positioned things */
}

header {
  position: sticky; /* scrolls, then sticks */
  top: 0;
}`,
        explain: '`absolute` takes an element out of the flow and places it relative to the nearest ancestor with `position: relative` (or the page). `sticky` scrolls normally until it reaches `top: 0`, then stays. `z-index` decides what’s on top, but only for positioned elements.',
      },
    },
  },
  {
    task: 'add hover effects and animations',
    asks: ['add a hover effect in css', 'animate a button', 'css transitions', 'css keyframe animation', 'make something fade in'],
    impls: {
      css: {
        code: `.button {
  background: #2563eb;
  color: white;
  transition: transform 0.2s ease, background 0.2s ease;
}

.button:hover {
  background: #1e40af;
  transform: translateY(-2px);
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card {
  animation: fade-in 0.6s ease both;
}`,
        explain: 'A `transition` animates a change of a property (here on `:hover`). `@keyframes` defines a named animation from one state to another, and `animation` plays it — `both` keeps the final state.',
      },
    },
  },
  {
    task: 'use CSS variables',
    asks: ['css variables', 'how do custom properties work in css', 'change the colour of my whole site in one place'],
    impls: {
      css: {
        code: `:root {
  --primary: #7c3aed;
  --radius: 12px;
}

.button {
  background: var(--primary);
  border-radius: var(--radius);
}

.dark {
  --primary: #a78bfa; /* children of .dark get this value */
}`,
        explain: 'Define variables (custom properties) with `--name` — usually on `:root` so every element can use them — and read them with `var(--name)`. Redefining a variable on a class changes it for everything inside, which is how themes and dark mode are usually built.',
      },
    },
  },
  {
    task: 'box-sizing and the box model',
    asks: ['what is the css box model', 'padding vs margin', 'why is my div wider than i set it', 'what does box-sizing border-box do'],
    impls: {
      css: {
        code: `* {
  box-sizing: border-box; /* width includes padding and border */
}

.box {
  width: 300px;
  padding: 20px;          /* space inside the border */
  border: 2px solid #333;
  margin: 16px;           /* space outside the border */
}`,
        explain: 'Every element is a box: content, then padding, then border, then margin. By default `width` is only the content, so padding and borders make it wider than you set. `box-sizing: border-box` makes `width` include them — most sites set it on everything.',
      },
    },
  },
  {
    task: 'link CSS and JavaScript files',
    asks: ['how do i link a css file to html', 'connect javascript to html', 'where do i put my script tag', 'my css file is not working'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My site</title>
  <link rel="stylesheet" href="style.css">
  <script src="script.js" defer></script>
</head>
<body>
  <h1>Hello</h1>
</body>
</html>`,
        explain: 'Put `<link rel="stylesheet" href="style.css">` in the `<head>`. Add scripts with `<script src="script.js" defer></script>` — `defer` runs it after the page is built, so it can find your elements. Paths are relative to the HTML file, so if nothing loads, check the file name and folder.',
      },
    },
  },
  {
    task: 'semantic HTML and accessibility',
    asks: ['what is semantic html', 'make my website accessible', 'what tags should i use for a page layout', 'what is alt text'],
    impls: {
      html: {
        code: `<header>
  <nav aria-label="Main">
    <a href="/">Home</a>
    <a href="/about">About</a>
  </nav>
</header>
<main>
  <article>
    <h1>My first post</h1>
    <img src="cat.jpg" alt="A ginger cat asleep on a keyboard">
    <p>Today my cat helped me code.</p>
  </article>
</main>
<footer>
  <p>© 2026 Me</p>
</footer>`,
        explain: 'Semantic tags (`header`, `nav`, `main`, `article`, `footer`, `button`) say what things *are*, which helps screen readers and search engines. Give images `alt` text that describes them, use real `<button>`s for actions, keep one `<h1>` per page, and make sure text has enough contrast.',
        run: frag,
      },
    },
  },
  {
    task: 'make an HTML form',
    asks: ['how do i make a form in html', 'html input types', 'contact form html', 'make a dropdown and checkboxes in html'],
    impls: {
      html: {
        code: `<form action="/signup" method="post">
  <label for="name">Name</label>
  <input id="name" name="name" required>

  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>

  <label for="plan">Plan</label>
  <select id="plan" name="plan">
    <option value="free">Free</option>
    <option value="pro">Pro</option>
  </select>

  <label><input type="checkbox" name="news"> Send me news</label>

  <button type="submit">Sign up</button>
</form>`,
        explain: 'Each input needs a `name` (that’s what gets sent) and a `<label>` (clicking it focuses the field). Types like `email`, `number` and `date` give better keyboards on phones and basic checks; `required` stops empty submits. `action` and `method` say where the data goes.',
        run: frag,
      },
    },
  },
  {
    task: 'make a navigation bar',
    asks: ['make a navbar', 'navigation bar with html and css', 'menu at the top of my website', 'horizontal menu css'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Navbar</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    nav { display: flex; align-items: center; justify-content: space-between; padding: 0 24px; height: 60px; background: #111827; color: white; }
    nav ul { display: flex; gap: 20px; list-style: none; margin: 0; padding: 0; }
    nav a { color: white; text-decoration: none; }
    nav a:hover { color: #93c5fd; }
  </style>
</head>
<body>
  <nav>
    <strong>MySite</strong>
    <ul>
      <li><a href="#home">Home</a></li>
      <li><a href="#about">About</a></li>
      <li><a href="#contact">Contact</a></li>
    </ul>
  </nav>
</body>
</html>`,
        explain: 'A `<nav>` with flexbox: `space-between` puts the logo on the left and the links on the right. The links are a list with its bullets and spacing removed, laid out in a row with `gap`.',
      },
    },
  },
  // --- JavaScript in the browser -------------------------------------------------------
  {
    task: 'what the DOM is',
    asks: ['what is the dom', 'change html with javascript', 'how do i change text on a page with javascript', 'select an element in javascript', 'queryselector vs getelementbyid'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DOM</title>
</head>
<body>
  <h1 id="title">Hello</h1>
  <ul class="list"></ul>
  <script>
    const title = document.getElementById('title');
    title.textContent = 'Hello, DOM!';
    title.style.color = 'purple';

    const list = document.querySelector('.list');
    for (const fruit of ['apple', 'banana', 'cherry']) {
      const li = document.createElement('li');
      li.textContent = fruit;
      list.append(li);
    }
  </script>
</body>
</html>`,
        explain: 'The DOM is the browser’s live model of your page, which JavaScript can read and change. Find elements with `getElementById` or `querySelector` (any CSS selector), change them with `textContent`, `style` and `classList`, and build new ones with `createElement` + `append`.',
      },
    },
  },
  {
    task: 'handle events',
    asks: ['how do i run code when a button is clicked', 'addeventlistener', 'javascript click event', 'detect a key press in javascript', 'events in javascript'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Events</title>
</head>
<body>
  <button id="btn">Clicked 0 times</button>
  <input id="name" placeholder="Type your name">
  <p id="greeting"></p>
  <script>
    let clicks = 0;
    const btn = document.getElementById('btn');
    btn.addEventListener('click', () => {
      clicks++;
      btn.textContent = 'Clicked ' + clicks + ' times';
    });

    document.getElementById('name').addEventListener('input', (event) => {
      document.getElementById('greeting').textContent = 'Hi, ' + event.target.value + '!';
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') btn.textContent = 'Clicked 0 times';
    });
  </script>
</body>
</html>`,
        explain: '`addEventListener(type, function)` runs the function when the event happens: `click` for buttons, `input` whenever a field changes, `keydown` for keys, `submit` for forms. The `event` object tells you details like which key or which element.',
      },
    },
  },
  {
    task: 'save data in the browser',
    asks: ['localstorage in javascript', 'save data in the browser', 'remember settings after reload', 'how do i store data without a database'],
    impls: {
      html: {
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Remember me</title>
</head>
<body>
  <label>Your name <input id="name"></label>
  <p id="hello"></p>
  <script>
    const input = document.getElementById('name');
    const hello = document.getElementById('hello');

    // Load what was saved last time (null the first time).
    const saved = JSON.parse(localStorage.getItem('profile') || 'null');
    if (saved) {
      input.value = saved.name;
      hello.textContent = 'Welcome back, ' + saved.name + '!';
    }

    input.addEventListener('input', () => {
      localStorage.setItem('profile', JSON.stringify({ name: input.value }));
    });
  </script>
</body>
</html>`,
        explain: '`localStorage.setItem(key, value)` saves a string that survives reloads; `getItem` reads it back (or gives `null`). It only stores text, so use `JSON.stringify` / `JSON.parse` for objects and arrays. It’s per website and per browser, and not for secrets.',
      },
    },
  },
  {
    task: 'async, await and promises',
    asks: ['how do async and await work', 'what is a promise in javascript', 'wait for something in javascript', 'explain async javascript'],
    impls: {
      javascript: {
        code: `function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('start');
  await wait(100);
  console.log('after 100 ms');
  const results = await Promise.all([wait(50).then(() => 'a'), wait(80).then(() => 'b')]);
  console.log(results.join(','));
}

main().catch((err) => console.error(err));`,
        explain: 'A promise is a value that arrives later. Inside an `async` function, `await` pauses until the promise settles, so asynchronous code reads top to bottom. `Promise.all` waits for several at once; use `try … catch` (or `.catch`) for errors.',
        run: { out: 'start\nafter 100 ms\na,b\n' },
      },
    },
  },
  {
    task: 'let, const and var',
    asks: ['difference between let const and var', 'when should i use const', 'javascript variables explained'],
    impls: {
      javascript: {
        code: `const name = 'Ada';   // can't be reassigned
let count = 0;        // can change
count = count + 1;

const list = [1, 2];
list.push(3);         // fine: the array itself can change

if (true) {
  let inside = 'only here';
  console.log(inside);
}
console.log(name, count, list.length);`,
        explain: 'Use `const` by default, `let` when the value changes, and avoid `var` (it ignores block scope). `const` stops reassignment, not changes inside objects and arrays. `let` and `const` only exist inside the `{ }` block they’re declared in.',
        run: { out: 'only here\nAda 1 3\n' },
      },
    },
  },
  {
    task: 'arrays: map, filter and reduce',
    asks: ['javascript array methods', 'map filter reduce explained', 'loop over an array in javascript', 'find an item in an array'],
    impls: {
      javascript: {
        code: `const products = [
  { name: 'Pen', price: 2, inStock: true },
  { name: 'Book', price: 12, inStock: false },
  { name: 'Bag', price: 30, inStock: true },
];

const names = products.map((p) => p.name);
const available = products.filter((p) => p.inStock);
const total = available.reduce((sum, p) => sum + p.price, 0);
const book = products.find((p) => p.name === 'Book');

console.log(names.join(', '));
console.log(available.length, total, book.price);`,
        explain: '`map` transforms every item, `filter` keeps the ones that pass a test, `reduce` combines them into one value, and `find` returns the first match. They don’t change the original array.',
        run: { out: 'Pen, Book, Bag\n2 32 12\n' },
      },
    },
  },
  {
    task: 'template literals and string methods',
    asks: ['how do i put a variable in a string in javascript', 'template literals', 'javascript string methods'],
    impls: {
      javascript: {
        code: `const name = 'Sam';
const items = 3;
console.log(\`Hi \${name}, you have \${items} item\${items === 1 ? '' : 's'}.\`);

const text = '  Hello World  ';
console.log(text.trim().toLowerCase());
console.log(text.includes('World'), text.trim().split(' '));`,
        explain: 'Backtick strings can include `${expressions}`. Useful methods: `trim`, `toLowerCase`/`toUpperCase`, `includes`, `split`, `replace`, `slice`.',
        run: { out: "Hi Sam, you have 3 items.\nhello world\ntrue [ 'Hello', 'World' ]\n" },
      },
    },
  },
  // --- programming ideas --------------------------------------------------------------
  {
    task: 'what a function is',
    asks: ['what is a function', 'how do functions work', 'parameters and return values', 'why use functions'],
    impls: {
      python: {
        code: `def area(width, height=1):
    """Returns the area of a rectangle."""
    return width * height


print(area(3, 4))
print(area(5))`,
        explain: 'A function is a named, reusable block of code. It takes inputs (parameters — `height=1` gives a default), does its work, and `return`s a result. Functions keep code short, testable and easy to change in one place.',
        run: { out: '12\n5\n' },
      },
    },
  },
  {
    task: 'what recursion is',
    asks: ['what is recursion', 'explain recursion simply', 'recursive function example'],
    impls: {
      python: {
        code: `def countdown(n):
    if n == 0:          # base case: stop here
        print("Liftoff!")
        return
    print(n)
    countdown(n - 1)    # the same problem, a bit smaller


countdown(3)`,
        explain: 'A recursive function calls itself on a smaller version of the problem, until it reaches a base case that stops it. Without a base case it would never end.',
        run: { out: '3\n2\n1\nLiftoff!\n' },
      },
    },
  },
  {
    task: 'loops',
    asks: ['how do loops work', 'for loop vs while loop', 'loop through a list in python', 'repeat code in python'],
    impls: {
      python: {
        code: `for fruit in ["apple", "banana"]:
    print(fruit)

for i in range(3):
    print("count", i)

n = 3
while n > 0:
    print("n is", n)
    n -= 1`,
        explain: 'A `for` loop goes through each item of a sequence (or `range` of numbers). A `while` loop repeats as long as its condition is true — make sure something changes, or it never stops. `break` leaves a loop early and `continue` skips to the next round.',
        run: { out: 'apple\nbanana\ncount 0\ncount 1\ncount 2\nn is 3\nn is 2\nn is 1\n' },
      },
    },
  },
  {
    task: 'Big-O notation',
    asks: ['what is big o notation', 'explain time complexity', 'why is my code slow with big lists'],
    impls: {
      python: {
        code: `items = list(range(10_000))
lookup = set(items)

# O(n): checks items one by one
print(9_999 in items)

# O(1) on average: a set jumps straight to the answer
print(9_999 in lookup)`,
        explain: 'Big-O describes how the work grows with the input size n. O(1) stays the same, O(log n) grows slowly (binary search), O(n) grows in step (one loop), and O(n²) grows fast (a loop inside a loop). Picking the right data structure — like a set for lookups — often turns slow code fast.',
        run: { out: 'True\nTrue\n' },
      },
    },
  },
  {
    task: 'git basics',
    asks: ['how do i use git', 'git basics', 'explain git commit and push', 'what is a git branch'],
    impls: {
      bash: {
        code: `#!/bin/bash
git init -q demo && cd demo
git config user.email you@example.com
git config user.name You
echo "hello" > file.txt
git add file.txt
git commit -qm "First commit"
git switch -qc feature
echo "more" >> file.txt
git commit -qam "Add more"
git log --oneline | wc -l | tr -d ' '`,
        explain: '`git init` starts a repository, `git add` stages changes, and `git commit -m` saves a snapshot. Branches (`git switch -c name`) let you work on something without touching `main`. `git push` uploads your commits and `git pull` downloads others’.',
        run: { out: '2\n' },
      },
    },
  },
  {
    task: 'debugging',
    asks: ['how do i debug my code', 'my code does not work what do i do', 'how to find bugs', 'tips for debugging'],
    impls: {
      python: {
        code: `def average(numbers):
    total = 0
    for n in numbers:
        total += n
    print("debug: total =", total, "count =", len(numbers))
    return total / len(numbers) if numbers else 0


print(average([4, 8, 6]))
print(average([]))`,
        explain: 'Read the error message and the line number first. Then check your assumptions: print the values just before things go wrong (or use a debugger), make the smallest example that still fails, and fix one thing at a time. Here the check `if numbers` avoids dividing by zero for an empty list.',
        run: { out: 'debug: total = 18 count = 3\n6.0\ndebug: total = 0 count = 0\n0\n' },
      },
    },
  },
];
