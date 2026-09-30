'use strict';

// Debugging: someone shows broken code and asks what's wrong. Each answer
// names the bug, explains it, and gives fixed code (which validate.js runs).
// `broken` is what the person pastes; `code` is the fix.

module.exports = [
  {
    task: 'a script that runs before the page exists',
    asks: ['my javascript says cannot read properties of null', 'document.getElementById returns null', 'why does my button click not work', 'my script cannot find my element'],
    impls: {
      html: {
        broken: `<head>
  <script>
    document.getElementById('btn').addEventListener('click', () => alert('hi'));
  </script>
</head>
<body>
  <button id="btn">Click</button>
</body>`,
        code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fixed</title>
</head>
<body>
  <button id="btn">Click</button>
  <script>
    document.getElementById('btn').addEventListener('click', () => alert('hi'));
  </script>
</body>
</html>`,
        explain: 'The script runs while the browser is still reading the `<head>`, before the `<button>` exists, so `getElementById` returns `null`. Move the `<script>` to the end of the `<body>` (as here), or keep it in the head as an external file with `<script src="app.js" defer>`, which waits for the page.',
      },
    },
  },
  {
    task: 'calling a function instead of passing it',
    asks: ['my function runs as soon as the page loads instead of on click', 'addeventlistener runs immediately', 'click handler fires without clicking'],
    impls: {
      javascript: {
        broken: `button.addEventListener('click', sayHello());`,
        code: `function sayHello() {
  console.log('hello');
}

// Pass the function itself — no parentheses.
const handlers = [];
const button = { addEventListener: (type, fn) => handlers.push(fn) };
button.addEventListener('click', sayHello);
console.log('nothing yet');
handlers[0]();`,
        explain: '`sayHello()` *calls* the function right away and passes its result (`undefined`) to `addEventListener`. Pass the function itself — `sayHello` without parentheses — or wrap it: `() => sayHello()`.',
        run: { out: 'nothing yet\nhello\n' },
      },
    },
  },
  {
    task: 'adding numbers from inputs gives text',
    asks: ['javascript adds numbers wrong 1 + 2 = 12', 'my calculator concatenates instead of adding', 'input values add like strings'],
    impls: {
      javascript: {
        broken: `const total = input1.value + input2.value; // "1" + "2" = "12"`,
        code: `const a = '1';
const b = '2';
console.log(a + b);                 // text: joins them
console.log(Number(a) + Number(b)); // numbers: adds them`,
        explain: 'Values from inputs are always strings, and `+` on strings joins them. Convert first with `Number(...)` (or `parseFloat`), or use `input.valueAsNumber` for number inputs.',
        run: { out: '12\n3\n' },
      },
    },
  },
  {
    task: '= instead of ===',
    asks: ['my if statement is always true', 'if (x = 5) always runs', 'difference between = == and ==='],
    impls: {
      javascript: {
        broken: `if (score = 10) { console.log('perfect'); }`,
        code: `let score = 7;
if (score === 10) {
  console.log('perfect');
} else {
  console.log('score is', score);
}
console.log(0 == '', 0 === '');`,
        explain: '`=` assigns, so `if (score = 10)` sets score to 10 and is always true. Compare with `===` (strict equality). Avoid `==`: it converts types first, so surprising things like `0 == \'\'` are true.',
        run: { out: 'score is 7\ntrue false\n' },
      },
    },
  },
  {
    task: 'an off-by-one loop',
    asks: ['my loop prints undefined at the end', 'index out of range in my loop', 'loop goes one too far'],
    impls: {
      python: {
        broken: `names = ["Ada", "Linus", "Grace"]
for i in range(len(names) + 1):
    print(names[i])`,
        code: `names = ["Ada", "Linus", "Grace"]
for name in names:
    print(name)

for i, name in enumerate(names):
    print(i, name)`,
        explain: 'Indexes go from 0 to `len - 1`, so `range(len(names) + 1)` goes one too far and raises `IndexError`. Loop over the items directly, or use `enumerate` if you need the index too.',
        run: { out: 'Ada\nLinus\nGrace\n0 Ada\n1 Linus\n2 Grace\n' },
      },
    },
  },
  {
    task: 'a mutable default argument',
    asks: ['python list keeps growing between function calls', 'default argument list bug python', 'why does my function remember old values'],
    impls: {
      python: {
        broken: `def add_item(item, basket=[]):
    basket.append(item)
    return basket`,
        code: `def add_item(item, basket=None):
    if basket is None:
        basket = []
    basket.append(item)
    return basket


print(add_item("apple"))
print(add_item("pear"))`,
        explain: 'A default value is created once, when the function is defined — so every call shares the same list and it keeps growing. Use `None` as the default and make a new list inside.',
        run: { out: "['apple']\n['pear']\n" },
      },
    },
  },
  {
    task: 'forgetting await',
    asks: ['my fetch returns a promise object instead of data', 'console log shows promise pending', 'async function returns promise'],
    impls: {
      javascript: {
        broken: `const data = fetch(url).json(); // TypeError / Promise { <pending> }`,
        code: `async function getData() {
  // Stand-in for fetch(url): a promise that resolves later.
  const response = await Promise.resolve({ json: async () => ({ ok: true }) });
  const data = await response.json();
  return data;
}

getData().then((data) => console.log(data.ok));`,
        explain: '`fetch` and `.json()` both return promises. Inside an `async` function, `await` each one to get the actual value. Code outside can use `.then(...)` or `await` too — an async function always returns a promise.',
        run: { out: 'true\n' },
      },
    },
  },
  {
    task: 'an indentation error',
    asks: ['python indentationerror', 'expected an indented block python', 'unexpected indent python'],
    impls: {
      python: {
        broken: `def greet(name):
print("hi", name)`,
        code: `def greet(name):
    print("hi", name)


greet("Sam")`,
        explain: 'Python uses indentation to know what’s inside a function, loop or `if`. Everything in the block must be indented the same amount — 4 spaces is the standard. Mixing tabs and spaces also causes this error.',
        run: { out: 'hi Sam\n' },
      },
    },
  },
  {
    task: 'comparing text and numbers in Python',
    asks: ['python input comparison not working', 'typeerror str and int python', 'input number if statement python not working'],
    impls: {
      python: {
        broken: `age = input("Age: ")
if age > 18:
    print("adult")`,
        code: `age = int("21")  # in your program: int(input("Age: "))
if age >= 18:
    print("adult")
else:
    print("not yet")`,
        explain: '`input()` always returns a string, and Python won’t compare a string with a number. Convert it with `int(...)` (or `float(...)`). Wrap it in `try/except ValueError` if people might type something that isn’t a number.',
        run: { out: 'adult\n' },
      },
    },
  },
  {
    task: 'CSS that doesn’t apply',
    asks: ['my css is not working', 'css changes do not show up', 'why is my style not applied', 'css class not working'],
    impls: {
      css: {
        broken: `.Title { color: red }     /* HTML says class="title" */
#box { width: 200 }        /* no unit */
.card { color: blue; }     /* a later rule says .card p { color: black } */`,
        code: `/* Class names are case-sensitive and must match the HTML. */
.title { color: red; }

/* Lengths need units (except 0). */
#box { width: 200px; }

/* More specific selectors win, so target the same thing. */
.card p { color: blue; }`,
        explain: 'The usual suspects: the stylesheet isn’t linked (check the path in `<link href>`), the selector doesn’t match (class names are case-sensitive), a value is invalid (like a missing `px`), or a more specific rule overrides it. Your browser’s dev tools (right-click → Inspect) show which rules apply and which are crossed out.',
      },
    },
  },
  {
    task: 'an infinite loop',
    asks: ['my program freezes', 'while loop never stops', 'my page hangs when i click'],
    impls: {
      python: {
        broken: `count = 0
while count < 5:
    print(count)`,
        code: `count = 0
while count < 5:
    print(count)
    count += 1`,
        explain: 'Nothing inside the loop changes `count`, so the condition is true forever. Make sure every loop moves towards its end — or use a `for` loop with `range`, which can’t get stuck.',
        run: { out: '0\n1\n2\n3\n4\n' },
      },
    },
  },
  {
    task: 'modifying a list while looping over it',
    asks: ['removing items from a list in a loop skips some', 'python remove in for loop bug'],
    impls: {
      python: {
        broken: `numbers = [1, 2, 2, 3]
for n in numbers:
    if n == 2:
        numbers.remove(n)`,
        code: `numbers = [1, 2, 2, 3]
numbers = [n for n in numbers if n != 2]
print(numbers)`,
        explain: 'Removing items while looping shifts the rest left, so the loop skips the next one (here, the second 2 survives). Build a new list instead, with a comprehension or `filter`.',
        run: { out: '[1, 3]\n' },
      },
    },
  },
  {
    task: 'this in a callback',
    asks: ['this is undefined in my javascript class', 'this inside settimeout is wrong', 'lost this in callback'],
    impls: {
      javascript: {
        broken: `class Timer {
  constructor() { this.count = 0; }
  start() { setTimeout(function () { this.count++; }, 10); }
}`,
        code: `class Timer {
  constructor() {
    this.count = 0;
  }

  start() {
    // Arrow functions keep the surrounding \`this\`.
    setTimeout(() => {
      this.count++;
      console.log('count is', this.count);
    }, 10);
  }
}

new Timer().start();`,
        explain: 'A regular `function` gets its own `this`, which isn’t your object when it’s called later as a callback. Use an arrow function (as here), or `this.method.bind(this)`.',
        run: { out: 'count is 1\n' },
      },
    },
  },
  {
    task: 'a missing return',
    asks: ['my function returns none', 'function returns undefined', 'why does my function give no result'],
    impls: {
      python: {
        broken: `def add(a, b):
    total = a + b

print(add(2, 3))  # None`,
        code: `def add(a, b):
    return a + b


print(add(2, 3))`,
        explain: 'A function without a `return` gives back `None` (or `undefined` in JavaScript). Printing inside a function isn’t the same as returning — `return` hands the value back to the caller.',
        run: { out: '5\n' },
      },
    },
  },
];
