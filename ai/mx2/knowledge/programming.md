## HTML
aka: html, hypertext markup language, what html is used for
HTML (HyperText Markup Language) is the language that describes the content and structure of a web page. It uses tags in angle brackets — like `<h1>` for a heading, `<p>` for a paragraph, `<a>` for a link and `<img>` for an image — and the browser turns them into the page you see.

A page starts with `<!DOCTYPE html>`, has a `<head>` (title, settings, styles) and a `<body>` (everything visible). HTML gives the structure; CSS styles it and JavaScript makes it interactive.
Q: What does HTML stand for? | HyperText Markup Language.
Q: Is HTML a programming language? | Not really — it’s a markup language: it describes content and structure, but has no logic like loops or conditions. JavaScript adds that.

## CSS
aka: css, cascading style sheets, styling a web page
CSS (Cascading Style Sheets) controls how a web page looks: colours, fonts, spacing, layout and animation. A CSS rule picks elements with a selector and sets properties, for example `h1 { color: navy; font-size: 2rem; }`.

Flexbox and grid are CSS layout systems for arranging things in rows, columns and grids, and media queries change the style on small screens so pages work on phones.
Q: How do I center something with CSS? | Make its parent a flexbox: `display: flex; justify-content: center; align-items: center;`.

## JavaScript
aka: javascript, js, what javascript is used for
JavaScript is the programming language of the web. It runs in every browser, where it makes pages interactive — reacting to clicks, updating content, checking forms and fetching data — and it also runs on servers and in tools through Node.js.

It has variables (`let`, `const`), functions, objects, arrays and events, and it’s a great first language because you only need a browser to try it.
Q: Is Java the same as JavaScript? | No — they’re different languages with similar names. Java is used for apps and servers; JavaScript is the language of web pages.

## Python
aka: python, python programming language
Python is a popular programming language known for being easy to read. It uses indentation instead of braces to group code, and has a huge standard library, so it’s used for everything from beginner projects and automation scripts to websites, data science and AI.

A first Python program is one line: `print("Hello, world!")`. Run a file with `python3 file.py`.
Q: Is Python good for beginners? | Yes — its clean, readable syntax makes it one of the best first languages.

## Variables
aka: variable, a variable, variables in programming
A variable is a name that stores a value so you can use it later, like a labelled box. In Python you write `age = 12`; in JavaScript `let age = 12;`. Later you can read it (`print(age)`) or change it (`age = 13`).

Values have types: numbers, text (strings), true/false (booleans), lists and more. Good variable names describe what they hold, like `total_price` rather than `x`.
Q: What is the difference between let and const? | In JavaScript, `let` can be reassigned later; `const` can’t. Use `const` by default and `let` when the value has to change.

## Functions
aka: function, a function, functions in programming, what a function does
A function is a named, reusable block of code that does one job. You give it inputs (parameters), it runs, and it can return an output. For example, in Python `def add(a, b): return a + b`, then `add(2, 3)` gives 5.

Functions let you write something once and use it many times, and they break big programs into small pieces that are easier to understand and test.
Q: What is a parameter? | A name in a function’s definition for an input it expects, like `a` and `b` in `add(a, b)`. The values you pass in are called arguments.

## Loops
aka: loop, loops, for loop, while loop, what a loop is
A loop repeats code. A `for` loop goes through a sequence — `for name in names:` runs once for each name — or counts, like `for (let i = 0; i < 10; i++)` in JavaScript. A `while` loop keeps going as long as a condition is true.

Loops save you from writing the same thing many times. Be careful a while loop’s condition eventually becomes false, or it runs forever.
Q: What is an infinite loop? | A loop whose condition never becomes false, so it never stops. Press Ctrl-C to stop a program stuck in one.

## Conditionals
aka: if statement, if statements, if else, conditionals
An if statement runs code only when a condition is true: `if age >= 18:` then do one thing, `else:` do another. You can chain more checks with `elif` (Python) or `else if` (JavaScript).

Conditions use comparisons (`==`, `!=`, `<`, `>`) and can be combined with `and`/`or` (`&&`/`||` in JavaScript).

## Arrays and lists
aka: array, arrays, list, lists in python
An array (called a list in Python) holds several values in order, like `[3, 1, 4]` or `["red", "green"]`. You get items by their position, starting at 0: `colors[0]` is the first.

You can add items (`append` in Python, `push` in JavaScript), remove them, sort them, loop over them, and find how many there are (`len(list)` or `array.length`).
Q: Why do arrays start at 0? | The index means "how far from the start", so the first item is 0 steps away. Most languages work this way.

## Objects and dictionaries
aka: object, objects, dictionary, dictionaries, dict, key value pairs
A dictionary (Python) or object (JavaScript) stores values by name instead of by position: `{"name": "Ada", "age": 36}`. You look things up by key — `person["name"]` or `person.name`.

They’re perfect for records with named fields, settings, and counting things (word → count).

## Strings
aka: string, strings, text in programming
A string is text in a program, written in quotes: `"hello"` or `'hello'`. You can join strings (`"a" + "b"`), find their length, change case, split them into words, search them and replace parts.

To put values into text, Python uses f-strings — `f"Hi {name}"` — and JavaScript uses template literals with backticks.

## Recursion
aka: recursion, recursive function, what recursion is
Recursion is when a function calls itself to solve a smaller version of the same problem. Every recursive function needs a base case that stops it, or it would call itself forever.

For example, the factorial of n is n × factorial(n − 1), and the factorial of 1 is 1 (the base case). Recursion is natural for things that contain smaller copies of themselves, like folders inside folders or tree structures.
Q: What is a base case? | The simplest case a recursive function answers directly, without calling itself — it’s what stops the recursion.

## Classes and objects
aka: class, classes, object oriented programming, oop
A class is a blueprint for making objects. It bundles data (attributes) and behaviour (methods) together: a `Dog` class might have a `name` and a `bark()` method, and each dog you create from it is an object, or instance.

Classes can inherit from other classes, so a `Cat` can reuse everything in an `Animal` class and change only what’s different. This style is called object-oriented programming.

## APIs
aka: api, apis, what an api is, rest api
An API (Application Programming Interface) is a way for programs to talk to each other. A web API lets your code ask a service for data or actions over the internet — for example, a weather API returns the forecast for a city as JSON when your program requests a URL.

Libraries have APIs too: the functions they offer you are their interface.

## JSON
aka: json, javascript object notation
JSON (JavaScript Object Notation) is a simple text format for data, made of objects in braces, arrays in brackets, strings, numbers, true/false and null — for example `{"name": "Ada", "skills": ["math", "code"]}`.

Almost every web API sends JSON. JavaScript reads it with `JSON.parse` and writes it with `JSON.stringify`; Python uses the `json` module.

## Bugs and debugging
aka: bug, bugs, debugging, how to debug, how to fix a bug
A bug is a mistake in a program that makes it behave wrongly. Debugging is finding and fixing it: read the error message (it usually names the file and line), reproduce the problem, then narrow it down by printing values or using a debugger to step through the code.

Changing one thing at a time and testing after each change makes bugs much easier to find.
Q: What is a syntax error? | A mistake in how the code is written — like a missing bracket or colon — so the language can’t even read it. The error message points to where it got confused.

## Compilers and interpreters
aka: compiler, interpreter, compiled language, interpreted language
Computers only run machine code, so programs must be translated. A compiler translates the whole program ahead of time into a runnable file (C, C++, Rust, Go). An interpreter reads and runs the program directly, step by step (Python, and JavaScript in its simplest form).

Many modern languages mix both: JavaScript engines compile hot code on the fly to make it fast.

## Git
aka: git commands, git basics, commit, branch
Git tracks the history of your code. You save snapshots called commits (`git add` then `git commit -m "message"`), work on separate lines of changes called branches (`git switch -c new-idea`), and share them with a remote like GitHub (`git push`, `git pull`).

If something breaks, git lets you see what changed (`git diff`) and go back to an earlier version.

## Terminal
aka: terminal, command line, shell, cli, the command line
The terminal (command line) lets you control a computer by typing commands instead of clicking. You navigate folders (`cd`, `ls`), manage files (`cp`, `mv`, `mkdir`), run programs and automate tasks. The program that reads your commands is the shell — like zsh, bash, or maxshell.

It looks plain but is very powerful: one command can do what would take hundreds of clicks.

## Databases and SQL
aka: sql query, database table, select statement
A database stores data in tables of rows and columns. SQL is the language for asking questions of it: `SELECT name FROM users WHERE age > 18 ORDER BY name;` gets the names of adults, sorted. `INSERT` adds rows, `UPDATE` changes them and `DELETE` removes them.

SQLite is a small database in a single file — great for learning.

## Frontend and backend
aka: frontend, backend, full stack, front end, back end
The frontend is the part of an app you see and use — in a website, the HTML, CSS and JavaScript running in your browser. The backend runs on a server: it stores data, handles accounts and does the work behind the scenes, often in a language like Python, JavaScript (Node.js), Go or Java, talking to a database.

A full-stack developer works on both.

## Open source
aka: open source, open source software
Open-source software is software whose code anyone can read, use, change and share, under a licence that allows it. Linux, Firefox, Python and many tools you use every day are open source, built by communities of volunteers and companies together.

## Algorithms and Big O
aka: big o, big o notation, time complexity, efficient code
Big O notation describes how an algorithm’s work grows with the size of its input. O(1) takes the same time no matter the size, O(n) grows in step with it (looking at every item once), O(n²) grows much faster (comparing every item with every other), and O(log n) grows very slowly (binary search halving the list each step).

It helps you choose code that stays fast when the data gets big.

## Machine learning
aka: machine learning, ml, training a model, neural networks explained
Machine learning is teaching computers by example instead of writing every rule. A model — often a neural network, made of layers of numbers called weights — looks at lots of examples, measures how wrong its guesses are, and nudges its weights to be a bit less wrong, millions of times. That’s called training.

Language models like me are trained to predict the next piece of text. I was trained on this Mac, on examples written for me.

## Learning to code
aka: how to learn to code, how to start programming, how to learn programming, learn to program
Pick one language — Python is friendly, JavaScript if you want websites — and start with the basics: variables, conditions, loops and functions. Then build tiny projects you care about: a calculator, a to-do list, a guessing game, your own web page.

You’ll learn most by getting stuck and fixing bugs. Read error messages carefully, search for them, and keep projects small enough to finish. A little every day beats a lot once a week.
Q: How long does it take to learn to code? | You can write useful small programs within a few weeks; getting really good takes a few years of practice.
Q: What should I build first? | Something small and fun: a number guessing game, a to-do list, a quiz, or a personal web page.
