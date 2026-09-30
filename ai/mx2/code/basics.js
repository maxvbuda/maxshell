'use strict';

// Core programming tasks, each in several languages. Every implementation
// is a complete program; `run` gives the input (argv or stdin) and the exact
// output expected, and ai/mx2/validate.js runs them all before they may enter
// the dataset.
//
// { task, asks: [ways to ask], impls: { python|javascript|c|bash|ruby|go…:
//   { code, explain, run: { args?, stdin?, out } } } }

module.exports = [
  {
    task: 'reverse a string',
    asks: ['write a program that reverses a string', 'how do i reverse a string in {lang}', 'reverse a string in {lang}', '{lang} code to reverse text', 'function to reverse a string'],
    impls: {
      python: {
        code: `def reverse(text):
    return text[::-1]


print(reverse("hello world"))`,
        explain: 'The slice `[::-1]` walks the string backwards, one character at a time.',
        run: { out: 'dlrow olleh\n' },
      },
      javascript: {
        code: `function reverse(text) {
  return [...text].reverse().join('');
}

console.log(reverse('hello world'));`,
        explain: 'Spreading the string into an array of characters lets you use `reverse()`, then `join(\'\')` glues it back together. Spreading (rather than `split(\'\')`) keeps emoji in one piece.',
        run: { out: 'dlrow olleh\n' },
      },
      c: {
        code: `#include <stdio.h>
#include <string.h>

void reverse(char *s) {
    size_t n = strlen(s);
    for (size_t i = 0; i < n / 2; i++) {
        char tmp = s[i];
        s[i] = s[n - 1 - i];
        s[n - 1 - i] = tmp;
    }
}

int main(void) {
    char text[] = "hello world";
    reverse(text);
    printf("%s\\n", text);
    return 0;
}`,
        explain: 'Swap the first and last characters, then move inwards until the two ends meet. It changes the string in place.',
        run: { out: 'dlrow olleh\n' },
      },
      bash: {
        code: `#!/bin/bash
text="hello world"
echo "$text" | rev`,
        explain: '`rev` reverses each line it reads.',
        run: { out: 'dlrow olleh\n' },
      },
    },
  },
  {
    task: 'check if a word is a palindrome',
    asks: ['check if a string is a palindrome', 'palindrome checker in {lang}', 'write a function that tells me if a word is a palindrome', 'is this word a palindrome {lang}'],
    impls: {
      python: {
        code: `def is_palindrome(text):
    cleaned = "".join(c.lower() for c in text if c.isalnum())
    return cleaned == cleaned[::-1]


for word in ["racecar", "hello", "A man, a plan, a canal: Panama"]:
    print(word, "->", is_palindrome(word))`,
        explain: 'Keep only letters and digits in lower case, then compare the text with its reverse.',
        run: { out: 'racecar -> True\nhello -> False\nA man, a plan, a canal: Panama -> True\n' },
      },
      javascript: {
        code: `function isPalindrome(text) {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned === [...cleaned].reverse().join('');
}

for (const word of ['racecar', 'hello', 'A man, a plan, a canal: Panama']) {
  console.log(word, '->', isPalindrome(word));
}`,
        explain: 'Lower-case it, strip everything that isn’t a letter or digit with a regular expression, then compare it with its reverse.',
        run: { out: 'racecar -> true\nhello -> false\nA man, a plan, a canal: Panama -> true\n' },
      },
    },
  },
  {
    task: 'FizzBuzz',
    asks: ['write fizzbuzz', 'fizzbuzz in {lang}', 'print numbers 1 to 15 but fizz for 3 and buzz for 5', 'solve fizzbuzz', 'how do i do fizzbuzz in {lang}'],
    impls: {
      python: {
        code: `for n in range(1, 16):
    if n % 15 == 0:
        print("FizzBuzz")
    elif n % 3 == 0:
        print("Fizz")
    elif n % 5 == 0:
        print("Buzz")
    else:
        print(n)`,
        explain: 'Check 15 first (divisible by both 3 and 5), then 3, then 5; `%` gives the remainder.',
        run: { out: '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n' },
      },
      javascript: {
        code: `for (let n = 1; n <= 15; n++) {
  if (n % 15 === 0) console.log('FizzBuzz');
  else if (n % 3 === 0) console.log('Fizz');
  else if (n % 5 === 0) console.log('Buzz');
  else console.log(n);
}`,
        explain: 'Check 15 first, because a number divisible by 15 is divisible by both 3 and 5.',
        run: { out: '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n' },
      },
      c: {
        code: `#include <stdio.h>

int main(void) {
    for (int n = 1; n <= 15; n++) {
        if (n % 15 == 0) printf("FizzBuzz\\n");
        else if (n % 3 == 0) printf("Fizz\\n");
        else if (n % 5 == 0) printf("Buzz\\n");
        else printf("%d\\n", n);
    }
    return 0;
}`,
        explain: 'The same checks in C: 15 first, then 3, then 5, otherwise the number itself.',
        run: { out: '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n' },
      },
      bash: {
        code: `#!/bin/bash
for n in $(seq 1 15); do
  if (( n % 15 == 0 )); then echo FizzBuzz
  elif (( n % 3 == 0 )); then echo Fizz
  elif (( n % 5 == 0 )); then echo Buzz
  else echo "$n"
  fi
done`,
        explain: '`(( … ))` does arithmetic in the shell, so the checks read just like in other languages.',
        run: { out: '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n' },
      },
    },
  },
  {
    task: 'the Fibonacci sequence',
    asks: ['print the fibonacci sequence', 'fibonacci in {lang}', 'write a function for fibonacci numbers', 'first 10 fibonacci numbers in {lang}', 'how do i make a fibonacci program'],
    impls: {
      python: {
        code: `def fibonacci(count):
    a, b = 0, 1
    numbers = []
    for _ in range(count):
        numbers.append(a)
        a, b = b, a + b
    return numbers


print(fibonacci(10))`,
        explain: 'Keep the last two numbers; each step, the next number is their sum. Doing it in a loop is fast, unlike the naive recursive version.',
        run: { out: '[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]\n' },
      },
      javascript: {
        code: `function fibonacci(count) {
  const numbers = [];
  let a = 0;
  let b = 1;
  for (let i = 0; i < count; i++) {
    numbers.push(a);
    [a, b] = [b, a + b];
  }
  return numbers;
}

console.log(fibonacci(10).join(', '));`,
        explain: 'Each step adds the previous two numbers; destructuring `[a, b] = [b, a + b]` moves both along at once.',
        run: { out: '0, 1, 1, 2, 3, 5, 8, 13, 21, 34\n' },
      },
      c: {
        code: `#include <stdio.h>

int main(void) {
    long a = 0, b = 1;
    for (int i = 0; i < 10; i++) {
        printf("%ld\\n", a);
        long next = a + b;
        a = b;
        b = next;
    }
    return 0;
}`,
        explain: 'A loop with two variables holding the last two numbers; `long` gives room for bigger values.',
        run: { out: '0\n1\n1\n2\n3\n5\n8\n13\n21\n34\n' },
      },
    },
  },
  {
    task: 'find prime numbers',
    asks: ['check if a number is prime', 'print prime numbers up to 30', 'prime number checker in {lang}', 'write a function to test for primes', 'find all primes below a number in {lang}'],
    impls: {
      python: {
        code: `def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True


print([n for n in range(30) if is_prime(n)])`,
        explain: 'A number is prime if nothing from 2 up to its square root divides it — any larger factor would pair with a smaller one you already checked.',
        run: { out: '[2, 3, 5, 7, 11, 13, 17, 19, 23, 29]\n' },
      },
      javascript: {
        code: `function isPrime(n) {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}

const primes = [];
for (let n = 0; n < 30; n++) if (isPrime(n)) primes.push(n);
console.log(primes.join(' '));`,
        explain: 'Only test divisors up to the square root of n; if none divides it evenly, it’s prime.',
        run: { out: '2 3 5 7 11 13 17 19 23 29\n' },
      },
      c: {
        code: `#include <stdio.h>
#include <stdbool.h>

bool is_prime(int n) {
    if (n < 2) return false;
    for (int i = 2; i * i <= n; i++)
        if (n % i == 0) return false;
    return true;
}

int main(void) {
    for (int n = 0; n < 30; n++)
        if (is_prime(n)) printf("%d ", n);
    printf("\\n");
    return 0;
}`,
        explain: 'Trial division up to the square root, using `stdbool.h` for `true` and `false`.',
        run: { out: '2 3 5 7 11 13 17 19 23 29 \n' },
      },
    },
  },
  {
    task: 'calculate a factorial',
    asks: ['factorial in {lang}', 'write a factorial function', 'recursive factorial in {lang}', 'how do i calculate factorial'],
    impls: {
      python: {
        code: `def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)


for n in range(6):
    print(n, factorial(n))`,
        explain: 'Recursion: n! is n times (n−1)!, and the base case stops it at 1.',
        run: { out: '0 1\n1 1\n2 2\n3 6\n4 24\n5 120\n' },
      },
      javascript: {
        code: `function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

for (let n = 0; n < 6; n++) console.log(n, factorial(n));`,
        explain: 'Each call multiplies n by the factorial of n − 1 until it reaches 1.',
        run: { out: '0 1\n1 1\n2 2\n3 6\n4 24\n5 120\n' },
      },
      c: {
        code: `#include <stdio.h>

unsigned long long factorial(int n) {
    return n <= 1 ? 1 : n * factorial(n - 1);
}

int main(void) {
    for (int n = 0; n < 6; n++)
        printf("%d %llu\\n", n, factorial(n));
    return 0;
}`,
        explain: '`unsigned long long` holds large results (up to 20!).',
        run: { out: '0 1\n1 1\n2 2\n3 6\n4 24\n5 120\n' },
      },
    },
  },
  {
    task: 'count the words in text',
    asks: ['count words in a string', 'word count program in {lang}', 'how many words are in a sentence {lang}', 'count how often each word appears'],
    impls: {
      python: {
        code: `from collections import Counter

text = "the cat and the hat and the bat"
words = text.split()
print("words:", len(words))
for word, count in Counter(words).most_common(3):
    print(word, count)`,
        explain: '`split()` breaks the text on spaces; `Counter` tallies how often each word appears, and `most_common` sorts them.',
        run: { out: 'words: 8\nthe 3\nand 2\ncat 1\n' },
      },
      javascript: {
        code: `const text = 'the cat and the hat and the bat';
const words = text.split(/\\s+/);
console.log('words:', words.length);

const counts = {};
for (const word of words) counts[word] = (counts[word] || 0) + 1;
const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
for (const [word, count] of top) console.log(word, count);`,
        explain: 'Split on whitespace, count each word in an object, then sort the entries by count.',
        run: { out: 'words: 8\nthe 3\nand 2\ncat 1\n' },
      },
      bash: {
        code: `#!/bin/bash
text="the cat and the hat and the bat"
echo "words: $(echo "$text" | wc -w | tr -d ' ')"
echo "$text" | tr ' ' '\\n' | sort | uniq -c | sort -rn | head -3 | awk '{print $2, $1}'`,
        explain: 'One word per line with `tr`, then `sort | uniq -c` counts them and `sort -rn` puts the most common first.',
        run: { out: 'words: 8\nthe 3\nand 2\nhat 1\n' },
      },
    },
  },
  {
    task: 'sort a list of numbers',
    asks: ['sort a list in {lang}', 'how do i sort numbers in {lang}', 'sort an array', 'sort a list from biggest to smallest'],
    impls: {
      python: {
        code: `numbers = [42, 7, 19, 3, 25]
print(sorted(numbers))
print(sorted(numbers, reverse=True))`,
        explain: '`sorted()` returns a new sorted list; `reverse=True` sorts from biggest to smallest. `numbers.sort()` would sort the list in place instead.',
        run: { out: '[3, 7, 19, 25, 42]\n[42, 25, 19, 7, 3]\n' },
      },
      javascript: {
        code: `const numbers = [42, 7, 19, 3, 25];
console.log([...numbers].sort((a, b) => a - b));
console.log([...numbers].sort((a, b) => b - a));`,
        explain: 'Always pass a compare function for numbers: without it, `sort()` compares them as text, so 100 would come before 25.',
        run: { out: '[ 3, 7, 19, 25, 42 ]\n[ 42, 25, 19, 7, 3 ]\n' },
      },
      c: {
        code: `#include <stdio.h>
#include <stdlib.h>

int compare(const void *a, const void *b) {
    return *(const int *)a - *(const int *)b;
}

int main(void) {
    int numbers[] = {42, 7, 19, 3, 25};
    int n = sizeof numbers / sizeof numbers[0];
    qsort(numbers, n, sizeof numbers[0], compare);
    for (int i = 0; i < n; i++) printf("%d ", numbers[i]);
    printf("\\n");
    return 0;
}`,
        explain: '`qsort` from the standard library sorts any array given a compare function.',
        run: { out: '3 7 19 25 42 \n' },
      },
      bash: {
        code: `#!/bin/bash
printf '%s\\n' 42 7 19 3 25 | sort -n`,
        explain: '`sort -n` sorts numerically; add `-r` for biggest first.',
        run: { out: '3\n7\n19\n25\n42\n' },
      },
    },
  },
  {
    task: 'bubble sort',
    asks: ['write bubble sort', 'bubble sort in {lang}', 'implement a sorting algorithm by hand', 'show me how bubble sort works'],
    impls: {
      python: {
        code: `def bubble_sort(items):
    items = list(items)
    for end in range(len(items) - 1, 0, -1):
        swapped = False
        for i in range(end):
            if items[i] > items[i + 1]:
                items[i], items[i + 1] = items[i + 1], items[i]
                swapped = True
        if not swapped:
            break
    return items


print(bubble_sort([5, 1, 4, 2, 8]))`,
        explain: 'Each pass swaps neighbours that are out of order, so the largest value “bubbles” to the end. If a pass makes no swaps, the list is already sorted.',
        run: { out: '[1, 2, 4, 5, 8]\n' },
      },
      javascript: {
        code: `function bubbleSort(input) {
  const items = [...input];
  for (let end = items.length - 1; end > 0; end--) {
    let swapped = false;
    for (let i = 0; i < end; i++) {
      if (items[i] > items[i + 1]) {
        [items[i], items[i + 1]] = [items[i + 1], items[i]];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return items;
}

console.log(bubbleSort([5, 1, 4, 2, 8]).join(' '));`,
        explain: 'Neighbours are swapped until the largest value reaches the end; each pass needs one fewer comparison.',
        run: { out: '1 2 4 5 8\n' },
      },
    },
  },
  {
    task: 'binary search',
    asks: ['binary search in {lang}', 'write a binary search function', 'find a number in a sorted list quickly', 'how does binary search work'],
    impls: {
      python: {
        code: `def binary_search(items, target):
    low, high = 0, len(items) - 1
    while low <= high:
        mid = (low + high) // 2
        if items[mid] == target:
            return mid
        if items[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1


numbers = [2, 5, 8, 12, 16, 23, 38, 56]
print(binary_search(numbers, 23))
print(binary_search(numbers, 7))`,
        explain: 'Look at the middle of a sorted list: if the target is bigger, throw away the left half, otherwise the right half. Each step halves the search, so even a million items take about 20 steps.',
        run: { out: '5\n-1\n' },
      },
      javascript: {
        code: `function binarySearch(items, target) {
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (items[mid] === target) return mid;
    if (items[mid] < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

const numbers = [2, 5, 8, 12, 16, 23, 38, 56];
console.log(binarySearch(numbers, 23), binarySearch(numbers, 7));`,
        explain: 'Halve the range each time by comparing with the middle element; it only works on sorted data.',
        run: { out: '5 -1\n' },
      },
    },
  },
  {
    task: 'find the largest number in a list',
    asks: ['find the biggest number in a list', 'max of an array in {lang}', 'find the largest and smallest number', 'get the maximum value'],
    impls: {
      python: {
        code: `numbers = [12, 45, 7, 89, 23]
print("largest:", max(numbers))
print("smallest:", min(numbers))`,
        explain: 'Python’s built-in `max()` and `min()` do it in one step.',
        run: { out: 'largest: 89\nsmallest: 7\n' },
      },
      javascript: {
        code: `const numbers = [12, 45, 7, 89, 23];
console.log('largest:', Math.max(...numbers));
console.log('smallest:', Math.min(...numbers));`,
        explain: 'The spread `...` passes the array’s items to `Math.max` and `Math.min` as separate arguments.',
        run: { out: 'largest: 89\nsmallest: 7\n' },
      },
      c: {
        code: `#include <stdio.h>

int main(void) {
    int numbers[] = {12, 45, 7, 89, 23};
    int n = sizeof numbers / sizeof numbers[0];
    int largest = numbers[0], smallest = numbers[0];
    for (int i = 1; i < n; i++) {
        if (numbers[i] > largest) largest = numbers[i];
        if (numbers[i] < smallest) smallest = numbers[i];
    }
    printf("largest: %d\\nsmallest: %d\\n", largest, smallest);
    return 0;
}`,
        explain: 'Start with the first item and keep whichever is bigger (or smaller) as you walk the array.',
        run: { out: 'largest: 89\nsmallest: 7\n' },
      },
    },
  },
  {
    task: 'sum and average a list',
    asks: ['average of a list in {lang}', 'sum all numbers in an array', 'calculate the mean of some numbers', 'add up a list of numbers'],
    impls: {
      python: {
        code: `scores = [88, 92, 75, 64, 99]
total = sum(scores)
average = total / len(scores)
print(f"total: {total}")
print(f"average: {average:.1f}")`,
        explain: '`sum()` adds them up; divide by `len()` for the average. `:.1f` rounds to one decimal place when printing.',
        run: { out: 'total: 418\naverage: 83.6\n' },
      },
      javascript: {
        code: `const scores = [88, 92, 75, 64, 99];
const total = scores.reduce((sum, n) => sum + n, 0);
const average = total / scores.length;
console.log('total:', total);
console.log('average:', average.toFixed(1));`,
        explain: '`reduce` walks the array carrying a running total; `toFixed(1)` rounds to one decimal.',
        run: { out: 'total: 418\naverage: 83.6\n' },
      },
    },
  },
  {
    task: 'convert Celsius to Fahrenheit',
    asks: ['convert celsius to fahrenheit in {lang}', 'temperature converter program', 'write a function that converts temperatures'],
    impls: {
      python: {
        code: `def c_to_f(celsius):
    return celsius * 9 / 5 + 32


def f_to_c(fahrenheit):
    return (fahrenheit - 32) * 5 / 9


print(c_to_f(100))
print(round(f_to_c(98.6), 1))`,
        explain: 'Multiply by 9/5 and add 32 to go from Celsius to Fahrenheit; do the reverse to go back.',
        run: { out: '212.0\n37.0\n' },
      },
      javascript: {
        code: `const cToF = (c) => (c * 9) / 5 + 32;
const fToC = (f) => ((f - 32) * 5) / 9;

console.log(cToF(100));
console.log(fToC(98.6).toFixed(1));`,
        explain: 'Two small arrow functions, one for each direction.',
        run: { out: '212\n37.0\n' },
      },
    },
  },
  {
    task: 'a number guessing game',
    asks: ['make a number guessing game', 'guess the number game in {lang}', 'write a simple game in {lang}', 'code a guessing game where the computer picks a number'],
    impls: {
      python: {
        code: `import random

secret = random.randint(1, 100)
tries = 0
print("I'm thinking of a number between 1 and 100.")
while True:
    guess = int(input("Your guess: "))
    tries += 1
    if guess < secret:
        print("Higher!")
    elif guess > secret:
        print("Lower!")
    else:
        print(f"You got it in {tries} tries!")
        break`,
        explain: '`random.randint` picks the secret; the loop keeps asking with `input()` and gives a hint until the guess is right.',
        run: { skip: 'interactive and random' },
      },
      javascript: {
        code: `const readline = require('readline/promises');

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const secret = Math.floor(Math.random() * 100) + 1;
  let tries = 0;
  console.log("I'm thinking of a number between 1 and 100.");
  for (;;) {
    const guess = Number(await rl.question('Your guess: '));
    tries++;
    if (guess < secret) console.log('Higher!');
    else if (guess > secret) console.log('Lower!');
    else {
      console.log(\`You got it in \${tries} tries!\`);
      break;
    }
  }
  rl.close();
}

main();`,
        explain: 'In Node, `readline/promises` lets you `await` each line the player types.',
        run: { skip: 'interactive and random' },
      },
    },
  },
  {
    task: 'read a file line by line',
    asks: ['read a file in {lang}', 'how do i read a text file line by line', 'open a file and print it', 'read lines from a file in {lang}'],
    impls: {
      python: {
        code: `with open("notes.txt") as f:
    for number, line in enumerate(f, start=1):
        print(number, line.rstrip())`,
        explain: '`with open(...)` closes the file for you; looping over the file gives one line at a time, and `rstrip()` removes the newline.',
        run: { files: { 'notes.txt': 'first\nsecond\n' }, out: '1 first\n2 second\n' },
      },
      javascript: {
        code: `const fs = require('fs');

const lines = fs.readFileSync('notes.txt', 'utf8').split('\\n').filter(Boolean);
lines.forEach((line, i) => console.log(i + 1, line));`,
        explain: '`readFileSync` reads the whole file as text; split it on newlines to get the lines.',
        run: { files: { 'notes.txt': 'first\nsecond\n' }, out: '1 first\n2 second\n' },
      },
      bash: {
        code: `#!/bin/bash
n=0
while IFS= read -r line; do
  n=$((n + 1))
  echo "$n $line"
done < notes.txt`,
        explain: '`while read` reads one line at a time from the file given with `<`; `IFS=` and `-r` keep spaces and backslashes intact.',
        run: { files: { 'notes.txt': 'first\nsecond\n' }, out: '1 first\n2 second\n' },
      },
    },
  },
  {
    task: 'write to a file',
    asks: ['write text to a file in {lang}', 'save data to a file', 'how do i create a file and write to it', 'append a line to a file in {lang}'],
    impls: {
      python: {
        code: `with open("log.txt", "w") as f:
    f.write("first line\\n")

with open("log.txt", "a") as f:
    f.write("added later\\n")

print(open("log.txt").read(), end="")`,
        explain: 'Mode `"w"` creates or overwrites the file; `"a"` appends to the end.',
        run: { out: 'first line\nadded later\n' },
      },
      javascript: {
        code: `const fs = require('fs');

fs.writeFileSync('log.txt', 'first line\\n');
fs.appendFileSync('log.txt', 'added later\\n');
process.stdout.write(fs.readFileSync('log.txt', 'utf8'));`,
        explain: '`writeFileSync` replaces the file; `appendFileSync` adds to the end.',
        run: { out: 'first line\nadded later\n' },
      },
      bash: {
        code: `#!/bin/bash
echo "first line" > log.txt
echo "added later" >> log.txt
cat log.txt`,
        explain: '`>` writes (replacing the file) and `>>` appends.',
        run: { out: 'first line\nadded later\n' },
      },
    },
  },
  {
    task: 'work with JSON',
    asks: ['parse json in {lang}', 'read and write json', 'convert an object to json', 'how do i use json in {lang}'],
    impls: {
      python: {
        code: `import json

text = '{"name": "Ada", "languages": ["Python", "C"], "age": 36}'
person = json.loads(text)
print(person["name"], "knows", len(person["languages"]), "languages")

person["age"] += 1
print(json.dumps(person, indent=2))`,
        explain: '`json.loads` turns JSON text into Python dicts and lists; `json.dumps` turns them back into text (`indent` makes it readable).',
        run: { out: 'Ada knows 2 languages\n{\n  "name": "Ada",\n  "languages": [\n    "Python",\n    "C"\n  ],\n  "age": 37\n}\n' },
      },
      javascript: {
        code: `const text = '{"name": "Ada", "languages": ["Python", "C"], "age": 36}';
const person = JSON.parse(text);
console.log(person.name, 'knows', person.languages.length, 'languages');

person.age += 1;
console.log(JSON.stringify(person, null, 2));`,
        explain: '`JSON.parse` reads JSON text into an object; `JSON.stringify` writes it back (the `2` indents it).',
        run: { out: 'Ada knows 2 languages\n{\n  "name": "Ada",\n  "languages": [\n    "Python",\n    "C"\n  ],\n  "age": 37\n}\n' },
      },
    },
  },
  {
    task: 'a class with methods',
    asks: ['make a class in {lang}', 'object oriented example in {lang}', 'write a bank account class', 'how do classes work in {lang}'],
    impls: {
      python: {
        code: `class BankAccount:
    def __init__(self, owner, balance=0):
        self.owner = owner
        self.balance = balance

    def deposit(self, amount):
        self.balance += amount

    def withdraw(self, amount):
        if amount > self.balance:
            raise ValueError("not enough money")
        self.balance -= amount

    def __str__(self):
        return f"{self.owner}: \${self.balance}"


account = BankAccount("Sam", 100)
account.deposit(50)
account.withdraw(30)
print(account)
try:
    account.withdraw(500)
except ValueError as e:
    print("error:", e)`,
        explain: '`__init__` sets up each new object, methods take `self` as the object, and `__str__` controls how it prints. Raising an error stops overdrafts.',
        run: { out: 'Sam: $120\nerror: not enough money\n' },
      },
      javascript: {
        code: `class BankAccount {
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

  toString() {
    return \`\${this.owner}: $\${this.balance}\`;
  }
}

const account = new BankAccount('Sam', 100);
account.deposit(50);
account.withdraw(30);
console.log(String(account));
try {
  account.withdraw(500);
} catch (e) {
  console.log('error:', e.message);
}`,
        explain: 'The `constructor` sets up the object, methods use `this`, and throwing an `Error` refuses a withdrawal that’s too big.',
        run: { out: 'Sam: $120\nerror: not enough money\n' },
      },
    },
  },
  {
    task: 'use a dictionary / map',
    asks: ['how do i use a dictionary in {lang}', 'store key value pairs', 'make a phone book program', 'map example in {lang}'],
    impls: {
      python: {
        code: `phone_book = {"Ada": "555-0101", "Linus": "555-0199"}
phone_book["Grace"] = "555-0142"

for name in sorted(phone_book):
    print(name, phone_book[name])

print(phone_book.get("Alan", "not found"))`,
        explain: 'A dict maps keys to values; `get` returns a default instead of raising an error when a key is missing.',
        run: { out: 'Ada 555-0101\nGrace 555-0142\nLinus 555-0199\nnot found\n' },
      },
      javascript: {
        code: `const phoneBook = new Map([
  ['Ada', '555-0101'],
  ['Linus', '555-0199'],
]);
phoneBook.set('Grace', '555-0142');

for (const name of [...phoneBook.keys()].sort()) {
  console.log(name, phoneBook.get(name));
}
console.log(phoneBook.get('Alan') ?? 'not found');`,
        explain: 'A `Map` stores key/value pairs; `??` supplies a fallback when a key is missing.',
        run: { out: 'Ada 555-0101\nGrace 555-0142\nLinus 555-0199\nnot found\n' },
      },
    },
  },
  {
    task: 'filter and transform a list',
    asks: ['filter a list in {lang}', 'map filter example', 'get only the even numbers', 'double every number in a list'],
    impls: {
      python: {
        code: `numbers = list(range(1, 11))
evens = [n for n in numbers if n % 2 == 0]
doubled = [n * 2 for n in evens]
print(evens)
print(doubled)`,
        explain: 'List comprehensions filter (`if …`) and transform (`n * 2`) in one readable line.',
        run: { out: '[2, 4, 6, 8, 10]\n[4, 8, 12, 16, 20]\n' },
      },
      javascript: {
        code: `const numbers = Array.from({ length: 10 }, (_, i) => i + 1);
const evens = numbers.filter((n) => n % 2 === 0);
const doubled = evens.map((n) => n * 2);
console.log(evens.join(' '));
console.log(doubled.join(' '));`,
        explain: '`filter` keeps items that pass a test; `map` makes a new array with each item transformed.',
        run: { out: '2 4 6 8 10\n4 8 12 16 20\n' },
      },
    },
  },
  {
    task: 'handle errors',
    asks: ['error handling in {lang}', 'try catch example', 'how do i stop my program crashing on bad input', 'handle an exception in {lang}'],
    impls: {
      python: {
        code: `def safe_divide(a, b):
    try:
        return a / b
    except ZeroDivisionError:
        return None


for text in ["10", "abc"]:
    try:
        number = int(text)
        print("got", number, "->", safe_divide(100, number))
    except ValueError:
        print(f"'{text}' is not a number")

print(safe_divide(1, 0))`,
        explain: 'Put code that might fail in `try`; each `except` handles one kind of error so the program keeps running.',
        run: { out: "got 10 -> 10.0\n'abc' is not a number\nNone\n" },
      },
      javascript: {
        code: `function parseAge(text) {
  const age = Number(text);
  if (!Number.isInteger(age) || age < 0) throw new Error(\`'\${text}' is not a valid age\`);
  return age;
}

for (const text of ['42', 'abc', '-3']) {
  try {
    console.log('age:', parseAge(text));
  } catch (err) {
    console.log('error:', err.message);
  }
}`,
        explain: '`throw` signals a problem; `try … catch` handles it without crashing.',
        run: { out: "age: 42\nerror: 'abc' is not a valid age\nerror: '-3' is not a valid age\n" },
      },
    },
  },
  {
    task: 'count vowels',
    asks: ['count the vowels in a string', 'how many vowels are in a word {lang}', 'vowel counter'],
    impls: {
      python: {
        code: `def count_vowels(text):
    return sum(1 for c in text.lower() if c in "aeiou")


print(count_vowels("Hello World"))`,
        explain: 'Walk through each character and count the ones in "aeiou".',
        run: { out: '3\n' },
      },
      javascript: {
        code: `const countVowels = (text) => (text.match(/[aeiou]/gi) || []).length;

console.log(countVowels('Hello World'));`,
        explain: 'A case-insensitive regular expression finds every vowel; `|| []` handles text with none.',
        run: { out: '3\n' },
      },
    },
  },
  {
    task: 'remove duplicates from a list',
    asks: ['remove duplicates from a list', 'get unique values in {lang}', 'dedupe an array'],
    impls: {
      python: {
        code: `items = [3, 1, 3, 2, 1, 5]
unique = list(dict.fromkeys(items))
print(unique)`,
        explain: '`dict.fromkeys` keeps the first of each value and preserves the order; `set(items)` also works but loses the order.',
        run: { out: '[3, 1, 2, 5]\n' },
      },
      javascript: {
        code: `const items = [3, 1, 3, 2, 1, 5];
const unique = [...new Set(items)];
console.log(unique.join(' '));`,
        explain: 'A `Set` only keeps one of each value, and keeps them in the order they were added.',
        run: { out: '3 1 2 5\n' },
      },
    },
  },
  {
    task: 'check for anagrams',
    asks: ['check if two words are anagrams', 'anagram checker in {lang}'],
    impls: {
      python: {
        code: `def is_anagram(a, b):
    clean = lambda s: sorted(s.replace(" ", "").lower())
    return clean(a) == clean(b)


print(is_anagram("listen", "silent"))
print(is_anagram("hello", "world"))`,
        explain: 'Two words are anagrams if their letters, sorted, are the same.',
        run: { out: 'True\nFalse\n' },
      },
      javascript: {
        code: `const sortLetters = (s) => [...s.replace(/\\s/g, '').toLowerCase()].sort().join('');
const isAnagram = (a, b) => sortLetters(a) === sortLetters(b);

console.log(isAnagram('listen', 'silent'), isAnagram('hello', 'world'));`,
        explain: 'Sort the letters of both words and compare.',
        run: { out: 'true false\n' },
      },
    },
  },
  {
    task: 'generate a random password',
    asks: ['generate a random password in {lang}', 'password generator program', 'make a random string'],
    impls: {
      python: {
        code: `import secrets
import string


def make_password(length=16):
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(secrets.choice(alphabet) for _ in range(length))


password = make_password()
print(len(password))`,
        explain: 'Use `secrets` (not `random`) for passwords: it’s designed to be unpredictable.',
        run: { out: '16\n' },
      },
      javascript: {
        code: `const crypto = require('crypto');

function makePassword(length = 16) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

console.log(makePassword().length);`,
        explain: '`crypto.randomBytes` gives secure random numbers, each mapped to a character.',
        run: { out: '16\n' },
      },
    },
  },
  {
    task: 'find the greatest common divisor',
    asks: ['gcd of two numbers', 'greatest common divisor in {lang}', 'euclid algorithm'],
    impls: {
      python: {
        code: `def gcd(a, b):
    while b:
        a, b = b, a % b
    return a


print(gcd(48, 18))
print(48 * 18 // gcd(48, 18))`,
        explain: 'Euclid’s algorithm: replace (a, b) with (b, a mod b) until b is 0. The lowest common multiple is a × b ÷ gcd.',
        run: { out: '6\n144\n' },
      },
      javascript: {
        code: `const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

console.log(gcd(48, 18));
console.log((48 * 18) / gcd(48, 18));`,
        explain: 'The recursive form of Euclid’s algorithm; the second line is the lowest common multiple.',
        run: { out: '6\n144\n' },
      },
    },
  },
  {
    task: 'reverse a linked list',
    asks: ['linked list in {lang}', 'reverse a linked list', 'implement a linked list'],
    impls: {
      python: {
        code: `class Node:
    def __init__(self, value, next=None):
        self.value = value
        self.next = next


def reverse(head):
    prev = None
    while head:
        head.next, prev, head = prev, head, head.next
    return prev


def to_list(head):
    values = []
    while head:
        values.append(head.value)
        head = head.next
    return values


head = Node(1, Node(2, Node(3)))
print(to_list(reverse(head)))`,
        explain: 'Walk the list, pointing each node back at the previous one; at the end, the old tail is the new head.',
        run: { out: '[3, 2, 1]\n' },
      },
      javascript: {
        code: `function reverse(head) {
  let prev = null;
  while (head) {
    const next = head.next;
    head.next = prev;
    prev = head;
    head = next;
  }
  return prev;
}

let list = { value: 1, next: { value: 2, next: { value: 3, next: null } } };
list = reverse(list);
const values = [];
for (let n = list; n; n = n.next) values.push(n.value);
console.log(values.join(' -> '));`,
        explain: 'Save `next`, point the node backwards, and move on; `prev` ends up as the new head.',
        run: { out: '3 -> 2 -> 1\n' },
      },
    },
  },
  {
    task: 'a stack and a queue',
    asks: ['implement a stack in {lang}', 'stack and queue example', 'check balanced brackets'],
    impls: {
      python: {
        code: `def balanced(text):
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    for c in text:
        if c in "([{":
            stack.append(c)
        elif c in pairs:
            if not stack or stack.pop() != pairs[c]:
                return False
    return not stack


for s in ["(a[b]{c})", "(]", "(("]:
    print(s, balanced(s))`,
        explain: 'A stack (a list with `append`/`pop`) remembers open brackets; each closing bracket must match the most recent one.',
        run: { out: '(a[b]{c}) True\n(] False\n(( False\n' },
      },
      javascript: {
        code: `function balanced(text) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const c of text) {
    if ('([{'.includes(c)) stack.push(c);
    else if (c in pairs && stack.pop() !== pairs[c]) return false;
  }
  return stack.length === 0;
}

for (const s of ['(a[b]{c})', '(]', '((']) console.log(s, balanced(s));`,
        explain: 'Push opening brackets, pop on closing ones and check they match; anything left over means unbalanced.',
        run: { out: '(a[b]{c}) true\n(] false\n(( false\n' },
      },
    },
  },
  {
    task: 'a simple web server',
    asks: ['make a web server in {lang}', 'simple http server', 'serve a web page with {lang}', 'write an api that returns json'],
    impls: {
      javascript: {
        code: `const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/api/hello') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Hello!' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>It works!</h1>');
});

server.listen(3000, () => console.log('Open http://localhost:3000'));`,
        explain: 'Node’s built-in `http` module is enough: check `req.url` to decide what to send. Run it with `node server.js` and open http://localhost:3000.',
        run: { syntax: true },
      },
      python: {
        code: `from http.server import BaseHTTPRequestHandler, HTTPServer
import json


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/hello":
            body = json.dumps({"message": "Hello!"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        else:
            body = b"<h1>It works!</h1>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body)


print("Open http://localhost:8000")
HTTPServer(("", 8000), Handler).serve_forever()`,
        explain: 'Python’s standard library includes `http.server`; `do_GET` answers each request based on `self.path`.',
        run: { syntax: true },
      },
    },
  },
  {
    task: 'fetch data from an API',
    asks: ['fetch data from an api in {lang}', 'make an http request', 'call a rest api', 'download json from a url'],
    impls: {
      javascript: {
        code: `async function getUser(id) {
  const response = await fetch(\`https://jsonplaceholder.typicode.com/users/\${id}\`);
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
  return response.json();
}

getUser(1)
  .then((user) => console.log(user.name, '-', user.email))
  .catch((err) => console.error('failed:', err.message));`,
        explain: '`fetch` returns a promise; `await` waits for the response, `response.ok` checks the status, and `.json()` parses the body. Works in browsers and in Node 18+.',
        run: { syntax: true },
      },
      python: {
        code: `import json
import urllib.request

url = "https://jsonplaceholder.typicode.com/users/1"
with urllib.request.urlopen(url) as response:
    user = json.load(response)
print(user["name"], "-", user["email"])`,
        explain: '`urllib.request` is built in; for bigger projects many people use the `requests` package (`pip3 install requests`).',
        run: { syntax: true },
      },
    },
  },
  {
    task: 'a command-line to-do list',
    asks: ['make a todo list app in {lang}', 'command line todo program', 'save tasks to a file'],
    impls: {
      python: {
        code: `import json
import os
import sys

FILE = "todos.json"


def load():
    if not os.path.exists(FILE):
        return []
    with open(FILE) as f:
        return json.load(f)


def save(todos):
    with open(FILE, "w") as f:
        json.dump(todos, f, indent=2)


todos = load()
command = sys.argv[1] if len(sys.argv) > 1 else "list"
if command == "add":
    todos.append({"task": " ".join(sys.argv[2:]), "done": False})
    save(todos)
elif command == "done":
    todos[int(sys.argv[2]) - 1]["done"] = True
    save(todos)
for i, todo in enumerate(todos, start=1):
    print(f"{i}. [{'x' if todo['done'] else ' '}] {todo['task']}")`,
        explain: 'Tasks live in a JSON file. `python3 todo.py add buy milk` adds one, `python3 todo.py done 1` ticks it off, and any command lists them.',
        run: { args: ['add', 'buy', 'milk'], out: '1. [ ] buy milk\n' },
      },
    },
  },
  {
    task: 'SQL queries',
    asks: ['write a sql query', 'sql select example', 'how do i use sql', 'create a table and query it'],
    impls: {
      sql: {
        code: `CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT, grade INTEGER);
INSERT INTO students (name, grade) VALUES ('Ada', 92), ('Linus', 85), ('Grace', 97);

SELECT name, grade FROM students WHERE grade > 90 ORDER BY grade DESC;
SELECT AVG(grade) FROM students;`,
        explain: '`CREATE TABLE` defines the columns, `INSERT` adds rows, `SELECT … WHERE … ORDER BY` picks and sorts them, and `AVG` is one of several aggregate functions (with `COUNT`, `SUM`, `MIN`, `MAX`).',
        run: { out: 'Grace|97\nAda|92\n91.333333333333329\n' },
      },
    },
  },
  {
    task: 'rename many files at once',
    asks: ['rename lots of files', 'batch rename files in bash', 'change file extensions for many files'],
    impls: {
      bash: {
        code: `#!/bin/bash
# Renames every .txt file in this folder to .md
for file in *.txt; do
  [ -e "$file" ] || continue
  mv -- "$file" "\${file%.txt}.md"
done
ls`,
        explain: '`\${file%.txt}` removes the `.txt` ending, so the loop moves each file to the same name with `.md`. Quoting \`"$file"\` keeps names with spaces safe.',
        run: { files: { 'a.txt': '', 'b c.txt': '' }, out: 'a.md\nb c.md\n' },
      },
    },
  },
  {
    task: 'a countdown timer',
    asks: ['countdown timer in {lang}', 'make a timer', 'wait one second between prints'],
    impls: {
      python: {
        code: `import time

for seconds in range(3, 0, -1):
    print(seconds)
    time.sleep(1)
print("Go!")`,
        explain: '`time.sleep(1)` pauses for a second between numbers.',
        run: { out: '3\n2\n1\nGo!\n' },
      },
      javascript: {
        code: `let seconds = 3;
const timer = setInterval(() => {
  if (seconds > 0) {
    console.log(seconds);
    seconds--;
  } else {
    console.log('Go!');
    clearInterval(timer);
  }
}, 1000);`,
        explain: '`setInterval` runs the function every 1000 ms until `clearInterval` stops it.',
        run: { out: '3\n2\n1\nGo!\n' },
      },
    },
  },
];
