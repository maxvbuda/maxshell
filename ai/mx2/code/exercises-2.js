'use strict';

// Everyday exercises, part 2: collections, algorithms, classes, errors and
// data. Each is a complete program in Python and JavaScript.

const { ex } = require('../exercise-kit');

module.exports = [
  ex('make a dictionary and loop over it', `
ages = {"Ada": 36, "Alan": 41, "Grace": 85}
for name, age in ages.items():
    print(name, age)`, `
const ages = { Ada: 36, Alan: 41, Grace: 85 };
for (const [name, age] of Object.entries(ages)) console.log(name, age);`, 'Ada 36\nAlan 41\nGrace 85\n', { python: '`items()` gives each key with its value.', javascript: '`Object.entries` turns an object into [key, value] pairs you can loop over.' }),

  ex('check if a key exists in a dictionary', `
stock = {"apples": 3, "pears": 0}
print("apples" in stock)
print(stock.get("kiwis", 0))`, `
const stock = { apples: 3, pears: 0 };
console.log('apples' in stock);
console.log(stock.kiwis ?? 0);`, { python: 'True\n0\n', javascript: 'true\n0\n' }, { python: '`in` checks the keys; `get(key, default)` returns the default instead of raising an error when the key is missing.', javascript: '`in` checks for a key; `??` supplies a default when the value is missing (undefined).' }),

  ex('merge two dictionaries', `
a = {"x": 1, "y": 2}
b = {"y": 20, "z": 30}
merged = {**a, **b}
print(merged)`, `
const a = { x: 1, y: 2 };
const b = { y: 20, z: 30 };
const merged = { ...a, ...b };
console.log(JSON.stringify(merged));`, { python: "{'x': 1, 'y': 20, 'z': 30}\n", javascript: '{"x":1,"y":20,"z":30}\n' }, 'Spread both into a new one; when a key is in both, the second wins (so y is 20).'),

  ex('make a class for a dog', `
class Dog:
    def __init__(self, name, breed):
        self.name = name
        self.breed = breed

    def bark(self):
        return f"{self.name} says woof!"


rex = Dog("Rex", "beagle")
print(rex.bark())
print(rex.breed)`, `
class Dog {
  constructor(name, breed) {
    this.name = name;
    this.breed = breed;
  }

  bark() {
    return this.name + ' says woof!';
  }
}

const rex = new Dog('Rex', 'beagle');
console.log(rex.bark());
console.log(rex.breed);`, 'Rex says woof!\nbeagle\n', { python: '`__init__` runs when you create a Dog and stores its details on `self`; methods like `bark` can then use them.', javascript: 'The `constructor` runs when you call `new Dog(...)`; methods use `this` to reach the object’s data.' }),

  ex('make a class for a bank account', `
class Account:
    def __init__(self, owner, balance=0):
        self.owner = owner
        self.balance = balance

    def deposit(self, amount):
        self.balance += amount

    def withdraw(self, amount):
        if amount > self.balance:
            raise ValueError("not enough money")
        self.balance -= amount


acct = Account("Max")
acct.deposit(50)
acct.withdraw(20)
print(acct.balance)
try:
    acct.withdraw(100)
except ValueError as e:
    print("error:", e)`, `
class Account {
  constructor(owner, balance = 0) {
    this.owner = owner;
    this.balance = balance;
  }

  deposit(amount) {
    this.balance += amount;
  }

  withdraw(amount) {
    if (amount > this.balance) throw new Error('not enough money');
    this.balance -= amount;
  }
}

const acct = new Account('Max');
acct.deposit(50);
acct.withdraw(20);
console.log(acct.balance);
try {
  acct.withdraw(100);
} catch (e) {
  console.log('error:', e.message);
}`, '30\nerror: not enough money\n', 'The account keeps its balance; `withdraw` refuses to go below zero by raising an error, which the caller catches.'),

  ex('handle an error when dividing by zero', `
def safe_divide(a, b):
    try:
        return a / b
    except ZeroDivisionError:
        return None


print(safe_divide(10, 2))
print(safe_divide(1, 0))`, `
function safeDivide(a, b) {
  if (b === 0) return null;
  return a / b;
}

console.log(safeDivide(10, 2));
console.log(safeDivide(1, 0));`, { python: '5.0\nNone\n', javascript: '5\nnull\n' }, { python: '`try` / `except ZeroDivisionError` catches the error Python raises and returns None instead.', javascript: 'JavaScript doesn’t throw on division by zero (it gives Infinity), so check for 0 yourself.' }),

  ex('convert a string to a number', `
print(int("42") + 1)
print(float("3.5") * 2)
try:
    int("abc")
except ValueError:
    print("not a number")`, `
console.log(Number('42') + 1);
console.log(parseFloat('3.5') * 2);
console.log(Number.isNaN(Number('abc')) ? 'not a number' : 'ok');`, { python: '43\n7.0\nnot a number\n', javascript: '43\n7\nnot a number\n' }, { python: '`int()` and `float()` convert text; they raise ValueError for text that isn’t a number.', javascript: '`Number()` converts text; it gives NaN for text that isn’t a number, which `Number.isNaN` detects.' }),

  ex('read input from the user', `
name = input("What is your name? ")
print(f"Hello, {name}!")`, `
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('What is your name? ', (name) => {
  console.log('Hello, ' + name + '!');
  rl.close();
});`, 'What is your name? Hello, Ada!\n', { python: '`input()` shows the prompt and waits for a line of text.', javascript: 'Node reads typed input with the `readline` module; `question` shows a prompt and calls you back with the answer.' }, { stdin: 'Ada\n' }),

  ex('implement binary search', `
def binary_search(items, target):
    lo, hi = 0, len(items) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if items[mid] == target:
            return mid
        if items[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1


numbers = [2, 5, 8, 12, 16, 23, 38]
print(binary_search(numbers, 23))
print(binary_search(numbers, 7))`, `
function binarySearch(items, target) {
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (items[mid] === target) return mid;
    if (items[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const numbers = [2, 5, 8, 12, 16, 23, 38];
console.log(binarySearch(numbers, 23));
console.log(binarySearch(numbers, 7));`, '5\n-1\n', 'On a sorted list, look at the middle: if the target is bigger, search the right half, otherwise the left. Each step halves the search, so it’s very fast.'),

  ex('implement bubble sort', `
def bubble_sort(items):
    items = list(items)
    for end in range(len(items) - 1, 0, -1):
        for i in range(end):
            if items[i] > items[i + 1]:
                items[i], items[i + 1] = items[i + 1], items[i]
    return items


print(bubble_sort([5, 1, 4, 2, 8]))`, `
function bubbleSort(input) {
  const items = [...input];
  for (let end = items.length - 1; end > 0; end--) {
    for (let i = 0; i < end; i++) {
      if (items[i] > items[i + 1]) [items[i], items[i + 1]] = [items[i + 1], items[i]];
    }
  }
  return items;
}

console.log(bubbleSort([5, 1, 4, 2, 8]).join(', '));`, { python: '[1, 2, 4, 5, 8]\n', javascript: '1, 2, 4, 5, 8\n' }, 'Bubble sort swaps neighbours that are in the wrong order; after each pass the biggest remaining item has "bubbled" to the end. It’s simple but slow — use the built-in sort for real work.'),

  ex('reverse a string using recursion', `
def reverse(text):
    if len(text) <= 1:
        return text
    return reverse(text[1:]) + text[0]


print(reverse("recursion"))`, `
function reverse(text) {
  if (text.length <= 1) return text;
  return reverse(text.slice(1)) + text[0];
}

console.log(reverse('recursion'));`, 'noisrucer\n', 'Recursion: the reverse of a string is the reverse of everything after the first letter, followed by the first letter. The base case (one letter or none) stops it.'),

  ex('flatten a nested list', `
def flatten(items):
    out = []
    for item in items:
        if isinstance(item, list):
            out.extend(flatten(item))
        else:
            out.append(item)
    return out


print(flatten([1, [2, [3, 4]], 5]))`, `
const nested = [1, [2, [3, 4]], 5];
console.log(nested.flat(Infinity).join(', '));`, { python: '[1, 2, 3, 4, 5]\n', javascript: '1, 2, 3, 4, 5\n' }, { python: 'Go through the items; when one is itself a list, flatten it (recursively) and add its items.', javascript: '`flat(Infinity)` flattens every level of nesting.' }),

  ex('make a stack', `
stack = []
stack.append("a")
stack.append("b")
stack.append("c")
print(stack.pop())
print(stack)`, `
const stack = [];
stack.push('a');
stack.push('b');
stack.push('c');
console.log(stack.pop());
console.log(stack.join(', '));`, { python: "c\n['a', 'b']\n", javascript: 'c\na, b\n' }, 'A stack is last-in, first-out: push onto the end and pop from the end.'),

  ex('make a queue', `
from collections import deque

queue = deque()
queue.append("first")
queue.append("second")
print(queue.popleft())
print(list(queue))`, `
const queue = [];
queue.push('first');
queue.push('second');
console.log(queue.shift());
console.log(queue.join(', '));`, { python: "first\n['second']\n", javascript: 'first\nsecond\n' }, { python: 'A queue is first-in, first-out. `deque` makes taking from the front (`popleft`) fast.', javascript: 'A queue is first-in, first-out: `push` adds to the back and `shift` takes from the front.' }),

  ex('encrypt text with a caesar cipher', `
def caesar(text, shift):
    out = ""
    for ch in text:
        if ch.isalpha():
            base = ord("A") if ch.isupper() else ord("a")
            out += chr((ord(ch) - base + shift) % 26 + base)
        else:
            out += ch
    return out


secret = caesar("Hello, World!", 3)
print(secret)
print(caesar(secret, -3))`, `
function caesar(text, shift) {
  return text.replace(/[a-z]/gi, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + shift + 26) % 26) + base);
  });
}

const secret = caesar('Hello, World!', 3);
console.log(secret);
console.log(caesar(secret, -3));`, 'Khoor, Zruog!\nHello, World!\n', 'Each letter moves `shift` places along the alphabet, wrapping round from z to a with `% 26`. Shifting back by the same amount decrypts it.'),

  ex('count the characters in a string', `
from collections import Counter

print(dict(Counter("banana")))`, `
const counts = {};
for (const ch of 'banana') counts[ch] = (counts[ch] || 0) + 1;
console.log(JSON.stringify(counts));`, { python: "{'b': 1, 'a': 3, 'n': 2}\n", javascript: '{"b":1,"a":3,"n":2}\n' }, 'Count each character as you go through the string.'),

  ex('turn a list into a string with commas', `
items = ["eggs", "milk", "bread"]
print(", ".join(items))
print(", ".join(items[:-1]) + " and " + items[-1])`, `
const items = ['eggs', 'milk', 'bread'];
console.log(items.join(', '));
console.log(items.slice(0, -1).join(', ') + ' and ' + items.at(-1));`, 'eggs, milk, bread\neggs, milk and bread\n', 'Join with ", "; for "a, b and c", join all but the last and add the last with "and".'),

  ex('convert a dictionary to json', `
import json

data = {"name": "Ada", "languages": ["python", "javascript"]}
text = json.dumps(data)
print(text)
print(json.loads(text)["name"])`, `
const data = { name: 'Ada', languages: ['python', 'javascript'] };
const text = JSON.stringify(data);
console.log(text);
console.log(JSON.parse(text).name);`, { python: '{"name": "Ada", "languages": ["python", "javascript"]}\nAda\n', javascript: '{"name":"Ada","languages":["python","javascript"]}\nAda\n' }, { python: '`json.dumps` turns Python data into JSON text; `json.loads` reads it back.', javascript: '`JSON.stringify` turns an object into JSON text; `JSON.parse` reads it back.' }),

  ex('write text to a file and read it back', `
import os
import tempfile

path = os.path.join(tempfile.gettempdir(), "notes.txt")
with open(path, "w") as f:
    f.write("first line\\nsecond line\\n")

with open(path) as f:
    for line in f:
        print(line.strip())`, `
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(os.tmpdir(), 'notes.txt');
fs.writeFileSync(file, 'first line\\nsecond line\\n');
for (const line of fs.readFileSync(file, 'utf8').trim().split('\\n')) console.log(line);`, 'first line\nsecond line\n', { python: '`with open(...)` opens the file and closes it for you; mode "w" writes (replacing the file), and looping over a file gives its lines.', javascript: '`fs.writeFileSync` writes the file and `fs.readFileSync(file, \'utf8\')` reads it back as text.' }),

  ex('find the second largest number in a list', `
numbers = [10, 40, 30, 40, 20]
unique = sorted(set(numbers))
print(unique[-2])`, `
const numbers = [10, 40, 30, 40, 20];
const unique = [...new Set(numbers)].sort((a, b) => b - a);
console.log(unique[1]);`, '30\n', 'Remove duplicates first (so a repeated maximum doesn’t count twice), sort, and take the second biggest.'),

  ex('check if all items in a list are positive', `
numbers = [3, 7, 1]
print(all(n > 0 for n in numbers))
print(any(n > 5 for n in numbers))`, `
const numbers = [3, 7, 1];
console.log(numbers.every((n) => n > 0));
console.log(numbers.some((n) => n > 5));`, { python: 'True\nTrue\n', javascript: 'true\ntrue\n' }, { python: '`all()` is true when every item passes; `any()` when at least one does.', javascript: '`every` is true when all items pass; `some` when at least one does.' }),

  ex('combine two lists into pairs', `
names = ["Ada", "Alan", "Grace"]
scores = [92, 85, 99]
for name, score in zip(names, scores):
    print(name, score)`, `
const names = ['Ada', 'Alan', 'Grace'];
const scores = [92, 85, 99];
names.forEach((name, i) => console.log(name, scores[i]));`, 'Ada 92\nAlan 85\nGrace 99\n', { python: '`zip` walks two lists side by side.', javascript: 'Loop over one array and use the index to get the matching item from the other.' }),

  ex('get the current date and time', `
from datetime import datetime

now = datetime(2026, 9, 30, 14, 5)
print(now.strftime("%Y-%m-%d %H:%M"))
print(now.strftime("%A, %B %d"))`, `
const now = new Date(2026, 8, 30, 14, 5);
console.log(now.toISOString().slice(0, 10));
console.log(now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }));`, { python: '2026-09-30 14:05\nWednesday, September 30\n', javascript: '2026-09-30\nWednesday, September 30\n' }, { python: 'Use `datetime.now()` for the current moment (a fixed date is used here so the output is predictable); `strftime` formats it.', javascript: 'Use `new Date()` for the current moment (a fixed date is used here so the output is predictable). Months count from 0, so 8 is September.' }),

  ex('calculate the number of days between two dates', `
from datetime import date

start = date(2026, 1, 1)
end = date(2026, 12, 25)
print((end - start).days)`, `
const start = new Date(2026, 0, 1);
const end = new Date(2026, 11, 25);
console.log(Math.round((end - start) / 86400000));`, '358\n', { python: 'Subtracting two dates gives a timedelta; `.days` is the number of days.', javascript: 'Subtracting dates gives milliseconds; divide by 86,400,000 (the milliseconds in a day).' }),

  ex('make a simple calculator', `
def calculate(a, op, b):
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b if b != 0 else "can't divide by zero"
    return "unknown operator"


print(calculate(6, "*", 7))
print(calculate(1, "/", 0))`, `
function calculate(a, op, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b !== 0 ? a / b : "can't divide by zero";
    default: return 'unknown operator';
  }
}

console.log(calculate(6, '*', 7));
console.log(calculate(1, '/', 0));`, "42\ncan't divide by zero\n", 'Pick the operation from the operator symbol, and handle division by zero separately.'),

  ex('make a number guessing game', `
import random


def play(secret, guesses):
    for tries, guess in enumerate(guesses, 1):
        if guess < secret:
            print(guess, "is too low")
        elif guess > secret:
            print(guess, "is too high")
        else:
            print(f"Got it in {tries} tries!")
            return


# secret = random.randint(1, 100) and guesses from input() in a real game
play(42, [50, 25, 42])`, `
function play(secret, guesses) {
  let tries = 0;
  for (const guess of guesses) {
    tries++;
    if (guess < secret) console.log(guess, 'is too low');
    else if (guess > secret) console.log(guess, 'is too high');
    else return console.log('Got it in ' + tries + ' tries!');
  }
}

// In a real game: secret = Math.floor(Math.random() * 100) + 1, guesses from the user.
play(42, [50, 25, 42]);`, '50 is too high\n25 is too low\nGot it in 3 tries!\n', 'Compare each guess with the secret and say higher or lower until it matches. The guesses are fixed here so you can see it run; read them from the user in a real game.'),

  ex('make a to-do list in the terminal', `
todos = []


def add(task):
    todos.append({"task": task, "done": False})


def finish(index):
    todos[index]["done"] = True


def show():
    for i, t in enumerate(todos):
        mark = "x" if t["done"] else " "
        print(f"[{mark}] {i}: {t['task']}")


add("buy milk")
add("write code")
finish(0)
show()`, `
const todos = [];
const add = (task) => todos.push({ task, done: false });
const finish = (i) => { todos[i].done = true; };
const show = () => todos.forEach((t, i) => console.log('[' + (t.done ? 'x' : ' ') + '] ' + i + ': ' + t.task));

add('buy milk');
add('write code');
finish(0);
show();`, '[x] 0: buy milk\n[ ] 1: write code\n', 'Each to-do is a small record with its text and whether it’s done; functions add, finish and show them.'),

  ex('find words longer than five letters', `
words = "the elephant walked slowly through grass".split()
print([w for w in words if len(w) > 5])`, `
const words = 'the elephant walked slowly through grass'.split(' ');
console.log(words.filter((w) => w.length > 5).join(', '));`, { python: "['elephant', 'walked', 'slowly', 'through']\n", javascript: 'elephant, walked, slowly, through\n' }, 'Keep only the words whose length is more than five.'),

  ex('make a shopping cart total', `
cart = [
    {"item": "apple", "price": 0.5, "qty": 6},
    {"item": "bread", "price": 2.25, "qty": 1},
]
total = sum(line["price"] * line["qty"] for line in cart)
print(f"Total: \${total:.2f}")`, `
const cart = [
  { item: 'apple', price: 0.5, qty: 6 },
  { item: 'bread', price: 2.25, qty: 1 },
];
const total = cart.reduce((sum, line) => sum + line.price * line.qty, 0);
console.log('Total: $' + total.toFixed(2));`, 'Total: $5.25\n', 'Multiply each line’s price by its quantity and add them up; format with two decimals for money.'),

  ex('transpose a matrix', `
matrix = [[1, 2, 3], [4, 5, 6]]
print([list(row) for row in zip(*matrix)])`, `
const matrix = [[1, 2, 3], [4, 5, 6]];
const t = matrix[0].map((_, c) => matrix.map((row) => row[c]));
console.log(JSON.stringify(t));`, { python: '[[1, 4], [2, 5], [3, 6]]\n', javascript: '[[1,4],[2,5],[3,6]]\n' }, 'Rows become columns: the new row c is the c-th item of every old row.'),

  ex('check if a string is a valid email', `
import re


def looks_like_email(text):
    return re.fullmatch(r"[^@\\s]+@[^@\\s]+\\.[a-z]{2,}", text, re.I) is not None


print(looks_like_email("ada@example.com"))
print(looks_like_email("not an email"))`, `
function looksLikeEmail(text) {
  return /^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(text);
}

console.log(looksLikeEmail('ada@example.com'));
console.log(looksLikeEmail('not an email'));`, { python: 'True\nFalse\n', javascript: 'true\nfalse\n' }, 'The pattern wants something, an @, a domain, a dot and at least two letters. It catches typos; the only real check is sending an email.'),

  ex('find the longest word in a sentence', `
sentence = "a journey of a thousand miles"
print(max(sentence.split(), key=len))`, `
const sentence = 'a journey of a thousand miles';
const longest = sentence.split(' ').reduce((a, b) => (b.length > a.length ? b : a));
console.log(longest);`, 'thousand\n', { python: '`max` with `key=len` compares the words by length.', javascript: '`reduce` keeps whichever word is longer as it goes.' }),

  ex('group words by their first letter', `
from collections import defaultdict

groups = defaultdict(list)
for word in ["apple", "avocado", "banana", "blueberry", "cherry"]:
    groups[word[0]].append(word)
print(dict(groups))`, `
const groups = {};
for (const word of ['apple', 'avocado', 'banana', 'blueberry', 'cherry']) {
  (groups[word[0]] ||= []).push(word);
}
console.log(JSON.stringify(groups));`, { python: "{'a': ['apple', 'avocado'], 'b': ['banana', 'blueberry'], 'c': ['cherry']}\n", javascript: '{"a":["apple","avocado"],"b":["banana","blueberry"],"c":["cherry"]}\n' }, { python: '`defaultdict(list)` starts each new key with an empty list, so you can append straight away.', javascript: '`||=` creates the list the first time a letter is seen.' }),

  ex('check if a number is an armstrong number', `
def is_armstrong(n):
    digits = str(n)
    return n == sum(int(d) ** len(digits) for d in digits)


print([n for n in range(100, 1000) if is_armstrong(n)])`, `
function isArmstrong(n) {
  const digits = String(n);
  return n === [...digits].reduce((s, d) => s + Number(d) ** digits.length, 0);
}

const found = [];
for (let n = 100; n < 1000; n++) if (isArmstrong(n)) found.push(n);
console.log(found.join(', '));`, { python: '[153, 370, 371, 407]\n', javascript: '153, 370, 371, 407\n' }, 'An Armstrong number equals the sum of its digits, each raised to the number of digits (153 = 1³ + 5³ + 3³).'),

  ex('compute the running total of a list', `
from itertools import accumulate

print(list(accumulate([1, 2, 3, 4])))`, `
let sum = 0;
console.log([1, 2, 3, 4].map((n) => (sum += n)).join(', '));`, { python: '[1, 3, 6, 10]\n', javascript: '1, 3, 6, 10\n' }, 'Each item is the sum of everything up to and including it.'),

  ex('chunk a list into groups of three', `
items = list(range(1, 9))
print([items[i:i + 3] for i in range(0, len(items), 3)])`, `
const items = [1, 2, 3, 4, 5, 6, 7, 8];
const chunks = [];
for (let i = 0; i < items.length; i += 3) chunks.push(items.slice(i, i + 3));
console.log(JSON.stringify(chunks));`, { python: '[[1, 2, 3], [4, 5, 6], [7, 8]]\n', javascript: '[[1,2,3],[4,5,6],[7,8]]\n' }, 'Step through the list three at a time and slice out each group; the last one can be shorter.'),

  ex('memoize a slow function', `
from functools import lru_cache


@lru_cache(maxsize=None)
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)


print(fib(50))`, `
const memo = new Map();
function fib(n) {
  if (n < 2) return n;
  if (!memo.has(n)) memo.set(n, fib(n - 1) + fib(n - 2));
  return memo.get(n);
}

console.log(fib(50));`, '12586269025\n', { python: '`@lru_cache` remembers results, so each fib(n) is only worked out once — without it, fib(50) would take minutes.', javascript: 'A Map remembers each result, so each fib(n) is only worked out once.' }),

  ex('remove an item from a list', `
pets = ["cat", "dog", "fish"]
pets.remove("dog")
print(pets)
del pets[0]
print(pets)`, `
let pets = ['cat', 'dog', 'fish'];
pets = pets.filter((p) => p !== 'dog');
console.log(pets.join(', '));
pets.splice(0, 1);
console.log(pets.join(', '));`, { python: "['cat', 'fish']\n['fish']\n", javascript: 'cat, fish\nfish\n' }, { python: '`remove` deletes the first matching value; `del list[i]` deletes by position.', javascript: '`filter` makes a copy without the value; `splice(i, 1)` removes one item at a position.' }),

  ex('add an item to a list', `
pets = ["cat"]
pets.append("dog")
pets.insert(0, "fish")
print(pets)`, `
const pets = ['cat'];
pets.push('dog');
pets.unshift('fish');
console.log(pets.join(', '));`, { python: "['fish', 'cat', 'dog']\n", javascript: 'fish, cat, dog\n' }, { python: '`append` adds to the end; `insert(0, x)` adds at the front.', javascript: '`push` adds to the end; `unshift` adds to the front.' }),

  ex('use a while loop', `
n = 1
while n < 100:
    n *= 2
print(n)`, `
let n = 1;
while (n < 100) n *= 2;
console.log(n);`, '128\n', 'A while loop repeats as long as its condition is true — here it keeps doubling until n reaches at least 100.'),

  ex('write a function with a default argument', `
def greet(name="friend"):
    return f"Hello, {name}!"


print(greet())
print(greet("Max"))`, `
function greet(name = 'friend') {
  return 'Hello, ' + name + '!';
}

console.log(greet());
console.log(greet('Max'));`, 'Hello, friend!\nHello, Max!\n', 'If you call it without an argument, the default value is used.'),

  ex('use a lambda function', `
double = lambda x: x * 2
print(double(21))
print(sorted(["bb", "a", "ccc"], key=lambda s: len(s)))`, `
const double = (x) => x * 2;
console.log(double(21));
console.log(['bb', 'a', 'ccc'].sort((a, b) => a.length - b.length).join(', '));`, { python: "42\n['a', 'bb', 'ccc']\n", javascript: '42\na, bb, ccc\n' }, { python: 'A lambda is a small unnamed function — handy for things like sort keys.', javascript: 'An arrow function `(x) => x * 2` is a short way to write a function, often passed to `sort` or `map`.' }),

  ex('format a number with commas', `
print(f"{1234567:,}")
print(f"{1234.5:,.2f}")`, `
console.log((1234567).toLocaleString('en-US'));
console.log((1234.5).toLocaleString('en-US', { minimumFractionDigits: 2 }));`, '1,234,567\n1,234.50\n', { python: 'The `,` format option adds thousands separators.', javascript: '`toLocaleString` formats numbers the way they’re written in a given locale.' }),

  ex('check if a string starts with a prefix', `
filename = "report-2026.pdf"
print(filename.startswith("report"))
print(filename.endswith(".pdf"))`, `
const filename = 'report-2026.pdf';
console.log(filename.startsWith('report'));
console.log(filename.endsWith('.pdf'));`, { python: 'True\nTrue\n', javascript: 'true\ntrue\n' }, 'Both languages have built-in checks for the start and end of a string.'),

  ex('replace a word in a string', `
text = "I like cats. cats are great."
print(text.replace("cats", "dogs"))`, `
const text = 'I like cats. cats are great.';
console.log(text.replaceAll('cats', 'dogs'));`, 'I like dogs. dogs are great.\n', { python: '`replace` changes every occurrence.', javascript: '`replaceAll` changes every occurrence (plain `replace` with a string only changes the first).' }),

  ex('make a countdown timer', `
import time


def countdown(seconds, wait=time.sleep):
    for s in range(seconds, 0, -1):
        print(f"{s}...")
        wait(1)
    print("Time's up!")


countdown(3, wait=lambda s: None)  # use countdown(3) to really wait`, `
function countdown(seconds) {
  if (seconds === 0) return console.log("Time's up!");
  console.log(seconds + '...');
  setTimeout(() => countdown(seconds - 1), 10); // 1000 for real seconds
}

countdown(3);`, "3...\n2...\n1...\nTime's up!\n", { python: '`time.sleep(1)` pauses for a second between numbers (switched off here so it runs instantly).', javascript: '`setTimeout` schedules the next tick; use 1000 milliseconds for real seconds.' }),

  ex('print the items of a list with their numbers', `
for i, fruit in enumerate(["apple", "banana", "cherry"], start=1):
    print(f"{i}. {fruit}")`, `
['apple', 'banana', 'cherry'].forEach((fruit, i) => console.log((i + 1) + '. ' + fruit));`, '1. apple\n2. banana\n3. cherry\n', { python: '`enumerate` gives each item with its position; `start=1` counts from 1.', javascript: '`forEach` passes each item and its index (from 0, so add 1).' }),

  ex('check if a number is in a range', `
age = 15
print(13 <= age <= 19)`, `
const age = 15;
console.log(age >= 13 && age <= 19);`, { python: 'True\n', javascript: 'true\n' }, { python: 'Python lets you chain comparisons: `13 <= age <= 19`.', javascript: 'Check both ends with `&&`.' }),

  ex('make a class that inherits from another', `
class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return "..."


class Cat(Animal):
    def speak(self):
        return f"{self.name} says meow"


print(Cat("Tom").speak())`, `
class Animal {
  constructor(name) {
    this.name = name;
  }

  speak() {
    return '...';
  }
}

class Cat extends Animal {
  speak() {
    return this.name + ' says meow';
  }
}

console.log(new Cat('Tom').speak());`, 'Tom says meow\n', { python: '`class Cat(Animal)` inherits everything from Animal and can override methods like `speak`.', javascript: '`class Cat extends Animal` inherits Animal’s constructor and methods and can override them.' }),

  ex('count the lines in a text', `
text = """first
second
third"""
print(len(text.splitlines()))`, `
const text = 'first\\nsecond\\nthird';
console.log(text.split('\\n').length);`, '3\n', 'Split the text into lines and count them.'),

  ex('find common items in two lists', `
a = [1, 2, 3, 4]
b = [3, 4, 5]
print(sorted(set(a) & set(b)))`, `
const a = [1, 2, 3, 4];
const b = [3, 4, 5];
console.log(a.filter((x) => b.includes(x)).join(', '));`, { python: '[3, 4]\n', javascript: '3, 4\n' }, { python: 'Sets have an intersection operator `&` that keeps what’s in both.', javascript: 'Keep the items of the first array that the second one includes.' }),

  ex('wait for a promise', `
import asyncio


async def fetch_number():
    await asyncio.sleep(0.01)
    return 42


async def main():
    print(await fetch_number())


asyncio.run(main())`, `
function fetchNumber() {
  return new Promise((resolve) => setTimeout(() => resolve(42), 10));
}

async function main() {
  console.log(await fetchNumber());
}

main();`, '42\n', { python: 'An `async` function can `await` slow work; `asyncio.run` starts the whole thing.', javascript: 'A Promise is a value that arrives later; inside an `async` function, `await` waits for it.' }),
];
