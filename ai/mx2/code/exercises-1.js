'use strict';

// Everyday exercises, part 1: numbers and text. Each is a complete program
// in Python and JavaScript; ai/mx2/validate.js runs every one.

const { ex } = require('../exercise-kit');

module.exports = [
  ex('add two numbers', `
def add(a, b):
    return a + b


print(add(2, 3))`, `
function add(a, b) {
  return a + b;
}

console.log(add(2, 3));`, '5\n', 'The function takes two numbers and returns their sum with `+`.'),

  ex('check if a number is even', `
def is_even(n):
    return n % 2 == 0


print(is_even(4))
print(is_even(7))`, `
function isEven(n) {
  return n % 2 === 0;
}

console.log(isEven(4));
console.log(isEven(7));`, { python: 'True\nFalse\n', javascript: 'true\nfalse\n' }, '`%` gives the remainder after dividing; an even number leaves a remainder of 0 when divided by 2.'),

  ex('check if a number is prime', `
def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True


print([n for n in range(20) if is_prime(n)])`, `
function isPrime(n) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}

const primes = [];
for (let n = 0; n < 20; n++) if (isPrime(n)) primes.push(n);
console.log(primes.join(', '));`, { python: '[2, 3, 5, 7, 11, 13, 17, 19]\n', javascript: '2, 3, 5, 7, 11, 13, 17, 19\n' }, 'A prime has no divisors other than 1 and itself. It’s enough to try divisors up to the square root (`i * i <= n`): if n had a bigger factor, it would also have a smaller one.'),

  ex('calculate the factorial of a number', `
def factorial(n):
    result = 1
    for i in range(2, n + 1):
        result *= i
    return result


print(factorial(5))`, `
function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

console.log(factorial(5));`, '120\n', 'The factorial of n is 1 × 2 × … × n, so the loop multiplies `result` by every number from 2 up to n. 5! = 120.'),

  ex('print the fibonacci sequence', `
def fibonacci(count):
    a, b = 0, 1
    numbers = []
    for _ in range(count):
        numbers.append(a)
        a, b = b, a + b
    return numbers


print(fibonacci(10))`, `
function fibonacci(count) {
  const numbers = [];
  let a = 0;
  let b = 1;
  for (let i = 0; i < count; i++) {
    numbers.push(a);
    [a, b] = [b, a + b];
  }
  return numbers;
}

console.log(fibonacci(10).join(' '));`, { python: '[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]\n', javascript: '0 1 1 2 3 5 8 13 21 34\n' }, 'Each Fibonacci number is the sum of the two before it. `a` and `b` hold the last two, and each step moves them along one place.'),

  ex('find the largest number in a list', `
def largest(numbers):
    best = numbers[0]
    for n in numbers:
        if n > best:
            best = n
    return best


print(largest([3, 41, 7, 19]))
print(max([3, 41, 7, 19]))  # the built-in does the same`, `
function largest(numbers) {
  let best = numbers[0];
  for (const n of numbers) {
    if (n > best) best = n;
  }
  return best;
}

console.log(largest([3, 41, 7, 19]));
console.log(Math.max(...[3, 41, 7, 19])); // the built-in does the same`, '41\n41\n', { python: 'Start with the first number and keep whichever is bigger as you go. Python’s built-in `max()` does this for you.', javascript: 'Start with the first number and keep whichever is bigger as you go. `Math.max(...list)` does it in one line.' }),

  ex('find the smallest number in a list', `
def smallest(numbers):
    best = numbers[0]
    for n in numbers:
        if n < best:
            best = n
    return best


print(smallest([8, 2, 9, 4]))`, `
function smallest(numbers) {
  let best = numbers[0];
  for (const n of numbers) {
    if (n < best) best = n;
  }
  return best;
}

console.log(smallest([8, 2, 9, 4]));`, '2\n', { python: 'Keep the smallest value seen so far. The built-in `min()` does the same in one call.', javascript: 'Keep the smallest value seen so far. `Math.min(...numbers)` does the same in one line.' }),

  ex('sum a list of numbers', `
def total(numbers):
    result = 0
    for n in numbers:
        result += n
    return result


print(total([4, 8, 15, 16, 23, 42]))
print(sum([4, 8, 15, 16, 23, 42]))`, `
function total(numbers) {
  return numbers.reduce((sum, n) => sum + n, 0);
}

console.log(total([4, 8, 15, 16, 23, 42]));`, { python: '108\n108\n', javascript: '108\n' }, { python: 'Add each number to a running total. Python’s built-in `sum()` does the same thing.', javascript: '`reduce` walks the array carrying a running total, starting from 0.' }),

  ex('calculate the average of a list', `
def average(numbers):
    return sum(numbers) / len(numbers)


print(average([2, 4, 6, 8]))`, `
function average(numbers) {
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

console.log(average([2, 4, 6, 8]));`, { python: '5.0\n', javascript: '5\n' }, 'The average (mean) is the total divided by how many numbers there are.'),

  ex('reverse a list', `
numbers = [1, 2, 3, 4, 5]
print(numbers[::-1])

numbers.reverse()  # or reverse it in place
print(numbers)`, `
const numbers = [1, 2, 3, 4, 5];
console.log([...numbers].reverse().join(', '));`, { python: '[5, 4, 3, 2, 1]\n[5, 4, 3, 2, 1]\n', javascript: '5, 4, 3, 2, 1\n' }, { python: '`[::-1]` makes a reversed copy; `.reverse()` reverses the list itself.', javascript: '`reverse()` changes the array it’s called on, so copy it first with `[...numbers]` if you want to keep the original.' }),

  ex('count the vowels in a string', `
def count_vowels(text):
    return sum(1 for ch in text.lower() if ch in "aeiou")


print(count_vowels("Hello World"))`, `
function countVowels(text) {
  let count = 0;
  for (const ch of text.toLowerCase()) {
    if ('aeiou'.includes(ch)) count++;
  }
  return count;
}

console.log(countVowels('Hello World'));`, '3\n', 'Lower-case the text so capitals count too, then count the characters that are one of a, e, i, o, u.'),

  ex('check if a word is a palindrome', `
def is_palindrome(word):
    word = word.lower()
    return word == word[::-1]


print(is_palindrome("Racecar"))
print(is_palindrome("hello"))`, `
function isPalindrome(word) {
  const w = word.toLowerCase();
  return w === [...w].reverse().join('');
}

console.log(isPalindrome('Racecar'));
console.log(isPalindrome('hello'));`, { python: 'True\nFalse\n', javascript: 'true\nfalse\n' }, 'A palindrome reads the same backwards, so compare the word with its reverse (after lower-casing it).'),

  ex('count the words in a sentence', `
def count_words(sentence):
    return len(sentence.split())


print(count_words("the quick brown fox jumps"))`, `
function countWords(sentence) {
  return sentence.trim().split(/\\s+/).length;
}

console.log(countWords('the quick brown fox jumps'));`, '5\n', { python: '`split()` with no argument splits on any run of spaces, so the length of the result is the number of words.', javascript: 'Splitting on `/\\s+/` (one or more spaces) gives the words; `trim()` first stops leading spaces making an empty word.' }),

  ex('capitalize the first letter of each word', `
def title_case(text):
    return " ".join(word[:1].upper() + word[1:] for word in text.split())


print(title_case("hello there general kenobi"))`, `
function titleCase(text) {
  return text.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

console.log(titleCase('hello there general kenobi'));`, 'Hello There General Kenobi\n', 'Split into words, upper-case the first letter of each and keep the rest, then join them back with spaces.'),

  ex('convert celsius to fahrenheit', `
def to_fahrenheit(celsius):
    return celsius * 9 / 5 + 32


print(to_fahrenheit(100))
print(to_fahrenheit(37))`, `
function toFahrenheit(celsius) {
  return celsius * 9 / 5 + 32;
}

console.log(toFahrenheit(100));
console.log(toFahrenheit(37));`, { python: '212.0\n98.6\n', javascript: '212\n98.6\n' }, 'Multiply by 9/5 and add 32. Going the other way: `(f - 32) * 5 / 9`.'),

  ex('convert fahrenheit to celsius', `
def to_celsius(fahrenheit):
    return (fahrenheit - 32) * 5 / 9


print(to_celsius(212))
print(round(to_celsius(70), 1))`, `
function toCelsius(fahrenheit) {
  return (fahrenheit - 32) * 5 / 9;
}

console.log(toCelsius(212));
console.log(toCelsius(70).toFixed(1));`, { python: '100.0\n21.1\n', javascript: '100\n21.1\n' }, 'Subtract 32, then multiply by 5/9.'),

  ex('print fizzbuzz', `
for n in range(1, 16):
    if n % 15 == 0:
        print("FizzBuzz")
    elif n % 3 == 0:
        print("Fizz")
    elif n % 5 == 0:
        print("Buzz")
    else:
        print(n)`, `
for (let n = 1; n <= 15; n++) {
  if (n % 15 === 0) console.log('FizzBuzz');
  else if (n % 3 === 0) console.log('Fizz');
  else if (n % 5 === 0) console.log('Buzz');
  else console.log(n);
}`, '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n', 'Check 15 first (divisible by both 3 and 5), then 3, then 5; otherwise print the number.'),

  ex('check if a year is a leap year', `
def is_leap(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


for year in [1900, 2000, 2024, 2026]:
    print(year, is_leap(year))`, `
function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

for (const year of [1900, 2000, 2024, 2026]) console.log(year, isLeap(year));`, { python: '1900 False\n2000 True\n2024 True\n2026 False\n', javascript: '1900 false\n2000 true\n2024 true\n2026 false\n' }, 'Leap years are divisible by 4, except century years, which must be divisible by 400 — so 2000 was a leap year but 1900 wasn’t.'),

  ex('count how many times each word appears', `
from collections import Counter

text = "the cat and the hat and the bat"
counts = Counter(text.split())
for word, n in counts.most_common(3):
    print(word, n)`, `
const text = 'the cat and the hat and the bat';
const counts = {};
for (const word of text.split(' ')) counts[word] = (counts[word] || 0) + 1;
const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
for (const [word, n] of top) console.log(word, n);`, 'the 3\nand 2\ncat 1\n', { python: '`Counter` counts everything in one go, and `most_common(3)` gives the top three.', javascript: 'An object maps each word to its count; `(counts[word] || 0) + 1` starts new words at 1. Sorting the entries by count gives the most common first.' }),

  ex('remove duplicates from a list', `
numbers = [3, 1, 3, 2, 1, 5]
unique = list(dict.fromkeys(numbers))
print(unique)`, `
const numbers = [3, 1, 3, 2, 1, 5];
const unique = [...new Set(numbers)];
console.log(unique.join(', '));`, { python: '[3, 1, 2, 5]\n', javascript: '3, 1, 2, 5\n' }, { python: '`dict.fromkeys` keeps the first of each value and its order; `set(numbers)` also works if you don’t care about order.', javascript: 'A `Set` only keeps one of each value, and spreading it back into an array keeps the original order.' }),

  ex('sort a list of numbers', `
numbers = [42, 7, 19, 3, 25]
print(sorted(numbers))
print(sorted(numbers, reverse=True))`, `
const numbers = [42, 7, 19, 3, 25];
console.log([...numbers].sort((a, b) => a - b).join(', '));
console.log([...numbers].sort((a, b) => b - a).join(', '));`, { python: '[3, 7, 19, 25, 42]\n[42, 25, 19, 7, 3]\n', javascript: '3, 7, 19, 25, 42\n42, 25, 19, 7, 3\n' }, { python: '`sorted()` returns a new sorted list; `reverse=True` sorts from biggest to smallest.', javascript: 'Pass `(a, b) => a - b` to `sort` — without it JavaScript sorts numbers as text, so 25 would come before 3.' }),

  ex('sort a list of words alphabetically', `
words = ["pear", "Apple", "banana", "cherry"]
print(sorted(words, key=str.lower))`, `
const words = ['pear', 'Apple', 'banana', 'cherry'];
console.log([...words].sort((a, b) => a.localeCompare(b)).join(', '));`, { python: "['Apple', 'banana', 'cherry', 'pear']\n", javascript: 'Apple, banana, cherry, pear\n' }, { python: '`key=str.lower` compares the words in lower case, so capitals don’t jump to the front.', javascript: '`localeCompare` compares text the way people expect, ignoring the capital-letters-first ordering of a plain sort.' }),

  ex('generate a random number between 1 and 10', `
import random

print(1 <= random.randint(1, 10) <= 10)`, `
const n = Math.floor(Math.random() * 10) + 1;
console.log(n >= 1 && n <= 10);`, { python: 'True\n', javascript: 'true\n' }, { python: '`random.randint(1, 10)` includes both ends. (The program prints True to show it’s always in range — print the number itself in your own code.)', javascript: '`Math.random()` gives 0 up to (not including) 1; multiply by 10, round down and add 1 to get 1 to 10. (The check prints true — log `n` itself in your own code.)' }),

  ex('swap two variables', `
a, b = 1, 2
a, b = b, a
print(a, b)`, `
let a = 1;
let b = 2;
[a, b] = [b, a];
console.log(a, b);`, '2 1\n', { python: 'Python can assign several names at once, so `a, b = b, a` swaps them without a temporary variable.', javascript: 'Destructuring assignment `[a, b] = [b, a]` swaps them in one line.' }),

  ex('check if a string contains a word', `
sentence = "the quick brown fox"
print("brown" in sentence)
print("purple" in sentence)`, `
const sentence = 'the quick brown fox';
console.log(sentence.includes('brown'));
console.log(sentence.includes('purple'));`, { python: 'True\nFalse\n', javascript: 'true\nfalse\n' }, { python: 'The `in` operator checks whether one string appears inside another.', javascript: '`includes` returns true if the text appears anywhere in the string.' }),

  ex('find the length of a string', `
name = "maxshell"
print(len(name))`, `
const name = 'maxshell';
console.log(name.length);`, '8\n', { python: '`len()` gives the number of characters.', javascript: 'Strings have a `length` property.' }),

  ex('convert a string to uppercase', `
print("hello world".upper())
print("HELLO WORLD".lower())`, `
console.log('hello world'.toUpperCase());
console.log('HELLO WORLD'.toLowerCase());`, 'HELLO WORLD\nhello world\n', { python: '`upper()` and `lower()` return new strings in upper or lower case.', javascript: '`toUpperCase()` and `toLowerCase()` return new strings.' }),

  ex('repeat a string several times', `
print("ha" * 3)
print("-" * 10)`, `
console.log('ha'.repeat(3));
console.log('-'.repeat(10));`, 'hahaha\n----------\n', { python: 'Multiplying a string by a number repeats it.', javascript: '`repeat(n)` joins n copies of the string.' }),

  ex('split a sentence into words', `
words = "red green blue".split()
print(words)
print(words[1])`, `
const words = 'red green blue'.split(' ');
console.log(words.length);
console.log(words[1]);`, { python: "['red', 'green', 'blue']\ngreen\n", javascript: '3\ngreen\n' }, 'Splitting on spaces gives a list of the words; indexes start at 0, so `[1]` is the second word.'),

  ex('join a list of words into a sentence', `
words = ["maxshell", "is", "fun"]
print(" ".join(words))
print(", ".join(words))`, `
const words = ['maxshell', 'is', 'fun'];
console.log(words.join(' '));
console.log(words.join(', '));`, 'maxshell is fun\nmaxshell, is, fun\n', { python: 'In Python you call `join` on the separator: `" ".join(words)`.', javascript: '`join` takes the separator to put between the items.' }),

  ex('round a number to two decimal places', `
price = 3.14159
print(round(price, 2))
print(f"{price:.2f}")`, `
const price = 3.14159;
console.log(Math.round(price * 100) / 100);
console.log(price.toFixed(2));`, '3.14\n3.14\n', { python: '`round(x, 2)` gives a number; the f-string `{x:.2f}` gives text with exactly two decimals.', javascript: '`toFixed(2)` gives text with two decimals; multiply, round and divide by 100 to keep a number.' }),

  ex('calculate the power of a number', `
print(2 ** 10)
print(pow(3, 4))`, `
console.log(2 ** 10);
console.log(Math.pow(3, 4));`, '1024\n81\n', 'The `**` operator raises a number to a power: 2 ** 10 is 2 multiplied by itself 10 times.'),

  ex('find the square root of a number', `
import math

print(math.sqrt(144))
print(round(math.sqrt(2), 3))`, `
console.log(Math.sqrt(144));
console.log(Math.sqrt(2).toFixed(3));`, { python: '12.0\n1.414\n', javascript: '12\n1.414\n' }, { python: '`math.sqrt` returns the square root (as a float).', javascript: '`Math.sqrt` returns the square root.' }),

  ex('check if a number is positive, negative or zero', `
def sign(n):
    if n > 0:
        return "positive"
    elif n < 0:
        return "negative"
    return "zero"


for n in [5, -3, 0]:
    print(n, sign(n))`, `
function sign(n) {
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'zero';
}

for (const n of [5, -3, 0]) console.log(n, sign(n));`, '5 positive\n-3 negative\n0 zero\n', 'An if / else-if chain checks each case in turn; whatever’s left over must be zero.'),

  ex('find the greatest common divisor', `
def gcd(a, b):
    while b:
        a, b = b, a % b
    return a


print(gcd(48, 18))`, `
function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

console.log(gcd(48, 18));`, '6\n', 'Euclid’s algorithm: replace (a, b) with (b, a mod b) until b is 0; then a is the greatest common divisor.'),

  ex('reverse the words in a sentence', `
sentence = "one two three four"
print(" ".join(reversed(sentence.split())))`, `
const sentence = 'one two three four';
console.log(sentence.split(' ').reverse().join(' '));`, 'four three two one\n', 'Split into words, reverse the list, and join it back together.'),

  ex('count down from 10', `
import time

for n in range(10, 0, -1):
    print(n)
print("Liftoff!")`, `
for (let n = 10; n >= 1; n--) console.log(n);
console.log('Liftoff!');`, '10\n9\n8\n7\n6\n5\n4\n3\n2\n1\nLiftoff!\n', { python: '`range(10, 0, -1)` counts down from 10 to 1 (the end, 0, isn’t included). Add `time.sleep(1)` inside the loop to wait a second each time.', javascript: 'The loop starts at 10 and subtracts 1 each time until it passes 1.' }),

  ex('print a multiplication table', `
n = 7
for i in range(1, 6):
    print(f"{n} x {i} = {n * i}")`, `
const n = 7;
for (let i = 1; i <= 5; i++) console.log(n + ' x ' + i + ' = ' + n * i);`, '7 x 1 = 7\n7 x 2 = 14\n7 x 3 = 21\n7 x 4 = 28\n7 x 5 = 35\n', 'Loop over the multipliers and print each product. Change `n` for a different table, or the range for more rows.'),

  ex('check if a list is empty', `
items = []
if not items:
    print("empty")
items.append("milk")
print(len(items) == 0)`, `
const items = [];
if (items.length === 0) console.log('empty');
items.push('milk');
console.log(items.length === 0);`, { python: 'empty\nFalse\n', javascript: 'empty\nfalse\n' }, { python: 'An empty list counts as false, so `if not items` reads naturally.', javascript: 'Check `length === 0` — an empty array is still truthy in JavaScript, so `if (!items)` doesn’t work.' }),

  ex('get the last item of a list', `
colours = ["red", "green", "blue"]
print(colours[-1])`, `
const colours = ['red', 'green', 'blue'];
console.log(colours[colours.length - 1]);
console.log(colours.at(-1));`, { python: 'blue\n', javascript: 'blue\nblue\n' }, { python: 'Negative indexes count from the end: `[-1]` is the last item.', javascript: 'The last index is `length - 1`; newer JavaScript also has `at(-1)`.' }),

  ex('make a list of squares', `
squares = [n * n for n in range(1, 6)]
print(squares)`, `
const squares = [1, 2, 3, 4, 5].map((n) => n * n);
console.log(squares.join(', '));`, { python: '[1, 4, 9, 16, 25]\n', javascript: '1, 4, 9, 16, 25\n' }, { python: 'A list comprehension builds the list in one line: an expression, then a `for`.', javascript: '`map` makes a new array by applying the function to every item.' }),

  ex('filter the even numbers from a list', `
numbers = [1, 2, 3, 4, 5, 6, 7, 8]
evens = [n for n in numbers if n % 2 == 0]
print(evens)`, `
const numbers = [1, 2, 3, 4, 5, 6, 7, 8];
const evens = numbers.filter((n) => n % 2 === 0);
console.log(evens.join(', '));`, { python: '[2, 4, 6, 8]\n', javascript: '2, 4, 6, 8\n' }, { python: 'Add an `if` to a list comprehension to keep only the items that pass.', javascript: '`filter` keeps the items for which the function returns true.' }),

  ex('convert a number to binary', `
print(bin(10))
print(format(10, "b"))
print(int("1010", 2))`, `
console.log((10).toString(2));
console.log(parseInt('1010', 2));`, { python: '0b1010\n1010\n10\n', javascript: '1010\n10\n' }, { python: '`format(n, "b")` gives the binary digits (`bin` adds a 0b prefix); `int(text, 2)` converts back.', javascript: '`toString(2)` writes a number in base 2; `parseInt(text, 2)` reads it back.' }),

  ex('check if two words are anagrams', `
def are_anagrams(a, b):
    return sorted(a.lower()) == sorted(b.lower())


print(are_anagrams("listen", "silent"))
print(are_anagrams("hello", "world"))`, `
function areAnagrams(a, b) {
  const key = (s) => [...s.toLowerCase()].sort().join('');
  return key(a) === key(b);
}

console.log(areAnagrams('listen', 'silent'));
console.log(areAnagrams('hello', 'world'));`, { python: 'True\nFalse\n', javascript: 'true\nfalse\n' }, 'Two words are anagrams if they have the same letters, so sort each word’s letters and compare.'),

  ex('calculate the area of a circle', `
import math


def circle_area(radius):
    return math.pi * radius ** 2


print(round(circle_area(3), 2))`, `
function circleArea(radius) {
  return Math.PI * radius ** 2;
}

console.log(circleArea(3).toFixed(2));`, '28.27\n', 'The area of a circle is π × r².'),

  ex('find the index of an item in a list', `
fruits = ["apple", "banana", "cherry"]
print(fruits.index("banana"))
print("grape" in fruits)`, `
const fruits = ['apple', 'banana', 'cherry'];
console.log(fruits.indexOf('banana'));
console.log(fruits.indexOf('grape'));`, { python: '1\nFalse\n', javascript: '1\n-1\n' }, { python: '`index` gives the position (from 0) but raises an error if the item is missing, so check with `in` first.', javascript: '`indexOf` gives the position from 0, or -1 when the item isn’t there.' }),

  ex('count from 1 to 10', `
for n in range(1, 11):
    print(n, end=" ")
print()`, `
const numbers = [];
for (let n = 1; n <= 10; n++) numbers.push(n);
console.log(numbers.join(' '));`, { python: '1 2 3 4 5 6 7 8 9 10 \n', javascript: '1 2 3 4 5 6 7 8 9 10\n' }, { python: '`range(1, 11)` goes from 1 up to 10 — the end number isn’t included. `end=" "` keeps them on one line.', javascript: 'A `for` loop counts from 1 while n is at most 10.' }),

  ex('remove spaces from a string', `
text = "  hello   world  "
print(text.strip())
print(text.replace(" ", ""))`, `
const text = '  hello   world  ';
console.log(text.trim());
console.log(text.replace(/ /g, ''));`, '  hello   world\nhelloworld\n'.replace(/^ {2}/, ''), { python: '`strip()` removes spaces from both ends; `replace(" ", "")` removes every space.', javascript: '`trim()` removes spaces from both ends; `replace(/ /g, \'\')` removes every space (the `g` means all of them).' }),

  ex('find the most common letter in a word', `
from collections import Counter

word = "mississippi"
letter, count = Counter(word).most_common(1)[0]
print(letter, count)`, `
const word = 'mississippi';
const counts = {};
for (const ch of word) counts[ch] = (counts[ch] || 0) + 1;
const [letter, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
console.log(letter, count);`, 'i 4\n', 'Count each letter, then take the one with the highest count.'),

  ex('check if a number is a multiple of another', `
def is_multiple(n, of):
    return n % of == 0


print(is_multiple(21, 7))
print(is_multiple(22, 7))`, `
function isMultiple(n, of) {
  return n % of === 0;
}

console.log(isMultiple(21, 7));
console.log(isMultiple(22, 7));`, { python: 'True\nFalse\n', javascript: 'true\nfalse\n' }, 'n is a multiple of another number when dividing leaves no remainder.'),

  ex('get the first n items of a list', `
letters = ["a", "b", "c", "d", "e"]
print(letters[:3])`, `
const letters = ['a', 'b', 'c', 'd', 'e'];
console.log(letters.slice(0, 3).join(', '));`, { python: "['a', 'b', 'c']\n", javascript: 'a, b, c\n' }, { python: 'Slicing `[:3]` takes everything before index 3.', javascript: '`slice(0, 3)` copies items 0, 1 and 2.' }),

  ex('find the difference between the biggest and smallest number', `
numbers = [12, 5, 31, 8]
print(max(numbers) - min(numbers))`, `
const numbers = [12, 5, 31, 8];
console.log(Math.max(...numbers) - Math.min(...numbers));`, '26\n', 'That’s the range of the numbers: the maximum minus the minimum.'),

  ex('calculate a tip', `
def tip(bill, percent=15):
    return round(bill * percent / 100, 2)


print(tip(40))
print(tip(62.5, 20))`, `
function tip(bill, percent = 15) {
  return Math.round(bill * percent) / 100;
}

console.log(tip(40));
console.log(tip(62.5, 20));`, { python: '6.0\n12.5\n', javascript: '6\n12.5\n' }, 'The tip is the bill times the percentage over 100. A default argument makes 15% the usual tip.'),

  ex('convert minutes to hours and minutes', `
def hours_and_minutes(total):
    hours, minutes = divmod(total, 60)
    return f"{hours}h {minutes}m"


print(hours_and_minutes(135))`, `
function hoursAndMinutes(total) {
  return Math.floor(total / 60) + 'h ' + (total % 60) + 'm';
}

console.log(hoursAndMinutes(135));`, '2h 15m\n', { python: '`divmod` gives the whole hours and the minutes left over in one go.', javascript: 'Whole hours are the minutes divided by 60, rounded down; `%` gives the minutes left over.' }),

  ex('check if a password is strong', `
def is_strong(password):
    return (len(password) >= 8
            and any(c.isupper() for c in password)
            and any(c.islower() for c in password)
            and any(c.isdigit() for c in password))


print(is_strong("hunter2"))
print(is_strong("Correct8Horse"))`, `
function isStrong(password) {
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password);
}

console.log(isStrong('hunter2'));
console.log(isStrong('Correct8Horse'));`, { python: 'False\nTrue\n', javascript: 'false\ntrue\n' }, 'The rules here: at least 8 characters, with an upper-case letter, a lower-case letter and a digit. Adjust them to taste.'),

  ex('generate a random password', `
import secrets
import string


def make_password(length=12):
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


print(len(make_password()))`, `
const crypto = require('crypto');

function makePassword(length = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

console.log(makePassword().length);`, '12\n', { python: 'Use the `secrets` module (not `random`) for passwords — it’s designed to be unpredictable. The program prints the length; print the password itself in yours.', javascript: '`crypto.randomInt` is unpredictable enough for passwords (`Math.random` isn’t). It prints the length; log the password itself in yours.' }),

  ex('print a triangle of stars', `
for i in range(1, 5):
    print("*" * i)`, `
for (let i = 1; i <= 4; i++) console.log('*'.repeat(i));`, '*\n**\n***\n****\n', 'Each row prints one more star than the last.'),

  ex('find all the divisors of a number', `
def divisors(n):
    return [d for d in range(1, n + 1) if n % d == 0]


print(divisors(28))`, `
function divisors(n) {
  const out = [];
  for (let d = 1; d <= n; d++) if (n % d === 0) out.push(d);
  return out;
}

console.log(divisors(28).join(', '));`, { python: '[1, 2, 4, 7, 14, 28]\n', javascript: '1, 2, 4, 7, 14, 28\n' }, 'Try every number from 1 to n and keep the ones that divide it exactly.'),

  ex('add up the digits of a number', `
def digit_sum(n):
    return sum(int(d) for d in str(n))


print(digit_sum(2026))`, `
function digitSum(n) {
  return [...String(n)].reduce((sum, d) => sum + Number(d), 0);
}

console.log(digitSum(2026));`, '10\n', 'Turn the number into text, then add up each digit as a number.'),
];
