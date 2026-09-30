'use strict';

// Everyday programming tasks. Every verified program is run by validate.js;
// languages with no toolchain on the training Mac are marked `unverified`.

module.exports = [
  {
    task: 'read a CSV file',
    asks: ['read a csv file in {lang}', 'parse csv data', 'load a spreadsheet csv and total a column', 'how do i work with csv files'],
    impls: {
      python: {
        code: `import csv

with open("sales.csv", newline="") as f:
    rows = list(csv.DictReader(f))

total = sum(float(row["amount"]) for row in rows)
print(len(rows), "sales, total", total)
for row in rows:
    print(f"{row['item']:<8} {row['amount']:>6}")`,
        explain: '`csv.DictReader` turns each row into a dict keyed by the header, so you can write `row["amount"]`. Values come in as strings — convert them with `float` or `int`.',
        run: { files: { 'sales.csv': 'item,amount\npen,2.50\nbook,12.00\nbag,30.00\n' }, out: '3 sales, total 44.5\npen        2.50\nbook      12.00\nbag       30.00\n' },
      },
      javascript: {
        code: `const fs = require('fs');

const [header, ...lines] = fs.readFileSync('sales.csv', 'utf8').trim().split('\\n');
const keys = header.split(',');
const rows = lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])));

const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
console.log(rows.length, 'sales, total', total);`,
        explain: 'For simple CSV (no commas inside values), split into lines and then on commas, using the header row as keys. For real-world CSV with quotes, use a library such as `csv-parse`.',
        run: { files: { 'sales.csv': 'item,amount\npen,2.50\nbook,12.00\nbag,30.00\n' }, out: '3 sales, total 44.5\n' },
      },
    },
  },
  {
    task: 'use regular expressions',
    asks: ['regex in {lang}', 'find all email addresses in text', 'extract numbers from a string', 'how do regular expressions work'],
    impls: {
      python: {
        code: `import re

text = "Contact ada@example.com or grace@navy.mil. Call 555-0142 or 555-0199."
emails = re.findall(r"[\\w.+-]+@[\\w-]+\\.[\\w.]+", text)
phones = re.findall(r"\\d{3}-\\d{4}", text)
print(emails)
print(phones)
print(re.sub(r"\\d", "#", "PIN 1234"))`,
        explain: '`re.findall` returns every match. `\\w` is a word character, `\\d` a digit, `+` means one or more, `{3}` exactly three. `re.sub` replaces matches. Raw strings (`r"..."`) keep the backslashes intact.',
        run: { out: "['ada@example.com', 'grace@navy.mil.']\n['555-0142', '555-0199']\nPIN ####\n" },
      },
      javascript: {
        code: `const text = 'Order #123 costs $45 and order #456 costs $78.';
const orders = [...text.matchAll(/#(\\d+)/g)].map((m) => m[1]);
const prices = text.match(/\\$\\d+/g);
console.log(orders.join(' '), prices.join(' '));
console.log('hello world'.replace(/o/g, '0'));`,
        explain: 'The `g` flag finds every match; `matchAll` gives each match with its capture groups (the part in parentheses). `replace` with a regex and `g` replaces them all.',
        run: { out: '123 456 $45 $78\nhell0 w0rld\n' },
      },
    },
  },
  {
    task: 'work with dates and times',
    asks: ['work with dates in {lang}', 'how many days between two dates', 'format a date', 'add days to a date'],
    impls: {
      python: {
        code: `from datetime import date, timedelta

start = date(2026, 1, 15)
end = date(2026, 3, 1)
print((end - start).days, "days apart")
print(start + timedelta(days=30))
print(start.strftime("%A %d %B %Y"))`,
        explain: 'Subtracting dates gives a `timedelta` (use `.days`); adding a `timedelta` moves a date. `strftime` formats it: `%A` weekday, `%d` day, `%B` month name, `%Y` year.',
        run: { out: '45 days apart\n2026-02-14\nThursday 15 January 2026\n' },
      },
      javascript: {
        code: `const start = new Date(2026, 0, 15); // months start at 0!
const end = new Date(2026, 2, 1);
const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
console.log(days, 'days apart');

const later = new Date(start);
later.setDate(later.getDate() + 30);
console.log(later.toISOString().slice(0, 10));`,
        explain: 'Subtracting dates gives milliseconds, so divide to get days. JavaScript months are zero-based (0 = January). `setDate` handles month roll-over for you.',
        run: { out: '45 days apart\n2026-02-14\n' },
      },
    },
  },
  {
    task: 'read command-line arguments',
    asks: ['command line arguments in {lang}', 'make a command line tool', 'read arguments passed to my script', 'argparse example'],
    impls: {
      python: {
        code: `import argparse

parser = argparse.ArgumentParser(description="Greet someone.")
parser.add_argument("name")
parser.add_argument("--times", type=int, default=1, help="how many times")
parser.add_argument("--shout", action="store_true")
args = parser.parse_args()

message = f"Hello, {args.name}!"
if args.shout:
    message = message.upper()
for _ in range(args.times):
    print(message)`,
        explain: '`argparse` handles arguments, options and `--help` for you. Run it as `python3 greet.py Ada --times 2 --shout`.',
        run: { args: ['Ada', '--times', '2', '--shout'], out: 'HELLO, ADA!\nHELLO, ADA!\n' },
      },
      javascript: {
        code: `const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) || 'world';
const shout = args.includes('--shout');
const message = \`Hello, \${name}!\`;
console.log(shout ? message.toUpperCase() : message);`,
        explain: '`process.argv` holds the command line; the first two entries are `node` and the script, so slice them off.',
        run: { args: ['Ada', '--shout'], out: 'HELLO, ADA!\n' },
      },
    },
  },
  {
    task: 'sort objects by a field',
    asks: ['sort a list of dictionaries by a key', 'sort objects by a property in javascript', 'sort people by age', 'sort by two fields'],
    impls: {
      python: {
        code: `people = [
    {"name": "Ada", "age": 36},
    {"name": "Linus", "age": 28},
    {"name": "Grace", "age": 36},
]
by_age = sorted(people, key=lambda p: p["age"])
by_age_then_name = sorted(people, key=lambda p: (-p["age"], p["name"]))
print([p["name"] for p in by_age])
print([p["name"] for p in by_age_then_name])`,
        explain: '`key=` tells `sorted` what to compare. Return a tuple to sort by several fields; negate a number to sort that field descending.',
        run: { out: "['Linus', 'Ada', 'Grace']\n['Ada', 'Grace', 'Linus']\n" },
      },
      javascript: {
        code: `const people = [
  { name: 'Ada', age: 36 },
  { name: 'Linus', age: 28 },
  { name: 'Grace', age: 36 },
];
const byAge = [...people].sort((a, b) => a.age - b.age);
const byName = [...people].sort((a, b) => a.name.localeCompare(b.name));
console.log(byAge.map((p) => p.name).join(' '));
console.log(byName.map((p) => p.name).join(' '));`,
        explain: 'The compare function returns a negative number if `a` should come first. Subtract for numbers; use `localeCompare` for text.',
        run: { out: 'Linus Ada Grace\nAda Grace Linus\n' },
      },
    },
  },
  {
    task: 'inheritance',
    asks: ['inheritance in {lang}', 'class inheritance example', 'subclass and override a method', 'what is polymorphism'],
    impls: {
      python: {
        code: `class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return "..."

    def introduce(self):
        return f"{self.name} says {self.speak()}"


class Dog(Animal):
    def speak(self):
        return "Woof"


class Cat(Animal):
    def speak(self):
        return "Meow"


for pet in [Dog("Rex"), Cat("Tom")]:
    print(pet.introduce())`,
        explain: '`Dog(Animal)` inherits everything from `Animal` and overrides `speak`. Code that calls `pet.introduce()` works for any animal — that’s polymorphism.',
        run: { out: 'Rex says Woof\nTom says Meow\n' },
      },
      javascript: {
        code: `class Animal {
  constructor(name) {
    this.name = name;
  }
  speak() {
    return '...';
  }
  introduce() {
    return \`\${this.name} says \${this.speak()}\`;
  }
}

class Dog extends Animal {
  speak() {
    return 'Woof';
  }
}

class Cat extends Animal {
  speak() {
    return 'Meow';
  }
}

for (const pet of [new Dog('Rex'), new Cat('Tom')]) console.log(pet.introduce());`,
        explain: '`extends` makes a subclass; redefining `speak` overrides the parent’s version. Use `super.method()` to call the parent’s one too.',
        run: { out: 'Rex says Woof\nTom says Meow\n' },
      },
    },
  },
  {
    task: 'dataclasses',
    asks: ['python dataclass', 'simple data object in python', 'avoid writing __init__ by hand'],
    impls: {
      python: {
        code: `from dataclasses import dataclass, field


@dataclass
class Item:
    name: str
    price: float
    tags: list = field(default_factory=list)

    def with_tax(self, rate=0.2):
        return round(self.price * (1 + rate), 2)


item = Item("Lamp", 25.0, ["home"])
print(item)
print(item.with_tax())`,
        explain: '`@dataclass` writes `__init__`, a readable `__repr__` and `==` for you from the type-annotated fields. Use `field(default_factory=list)` for list defaults.',
        run: { out: "Item(name='Lamp', price=25.0, tags=['home'])\n30.0\n" },
      },
    },
  },
  {
    task: 'generators',
    asks: ['what is a generator in python', 'yield keyword python', 'generate values lazily'],
    impls: {
      python: {
        code: `def squares(limit):
    n = 1
    while n * n <= limit:
        yield n * n
        n += 1


print(list(squares(50)))
total = sum(x for x in range(1_000_000) if x % 7 == 0)
print(total)`,
        explain: 'A function with `yield` produces values one at a time as they’re asked for, instead of building a whole list in memory. Generator expressions (the `(x for x in …)` form) do the same inline.',
        run: { out: '[1, 4, 9, 16, 25, 36, 49]\n71428928571\n' },
      },
    },
  },
  {
    task: 'decorators',
    asks: ['what is a decorator in python', 'time how long a function takes', 'python decorator example'],
    impls: {
      python: {
        code: `import functools


def logged(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        result = func(*args, **kwargs)
        print(f"{func.__name__}{args} -> {result}")
        return result
    return wrapper


@logged
def add(a, b):
    return a + b


add(2, 3)`,
        explain: 'A decorator is a function that wraps another function to add behaviour. `@logged` above `add` means `add = logged(add)`. `functools.wraps` keeps the original name and docstring.',
        run: { out: 'add(2, 3) -> 5\n' },
      },
    },
  },
  {
    task: 'use a SQLite database',
    asks: ['use sqlite in python', 'save data in a database with python', 'python database example'],
    impls: {
      python: {
        code: `import sqlite3

db = sqlite3.connect(":memory:")  # use a file name like "app.db" to keep it
db.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)")
db.executemany("INSERT INTO notes (text) VALUES (?)", [("buy milk",), ("call mum",)])
db.commit()

for row in db.execute("SELECT id, text FROM notes WHERE text LIKE ?", ("%milk%",)):
    print(row)
print(db.execute("SELECT COUNT(*) FROM notes").fetchone()[0])`,
        explain: '`sqlite3` is built into Python. Always pass values with `?` placeholders rather than building the SQL string yourself — that prevents SQL injection.',
        run: { out: "(1, 'buy milk')\n2\n" },
      },
    },
  },
  {
    task: 'write unit tests',
    asks: ['how do i write tests in {lang}', 'unit testing example', 'test my function'],
    impls: {
      python: {
        code: `import unittest


def add(a, b):
    return a + b


class TestAdd(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(add(2, 3), 5)

    def test_negative(self):
        self.assertEqual(add(-1, -1), -2)


if __name__ == "__main__":
    unittest.main(argv=["x"], exit=False, verbosity=0)
    print("done")`,
        explain: 'Each `test_…` method checks one behaviour with assertions like `assertEqual`. Run the file (or `python3 -m unittest`) to run them all; many projects use `pytest`, which lets you write plain `assert` statements.',
        run: { out: 'done\n' },
      },
      javascript: {
        code: `const test = require('node:test');
const assert = require('node:assert');

function add(a, b) {
  return a + b;
}

test('adds positive numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});

test('adds negative numbers', () => {
  assert.strictEqual(add(-1, -1), -2);
});`,
        explain: 'Node has a built-in test runner: `node --test` finds and runs your test files. Each `test` names a behaviour and checks it with `assert`.',
        run: { syntax: true },
      },
    },
  },
  {
    task: 'a Node module',
    asks: ['how do modules work in node', 'import and export in javascript', 'split my code into files'],
    impls: {
      javascript: {
        code: `// math.js would contain:
//   export function add(a, b) { return a + b; }
//   export const PI = 3.14159;
// and main.js:
//   import { add, PI } from './math.js';
//   console.log(add(2, 3), PI);
// (Use "type": "module" in package.json, or .mjs files.)

// CommonJS style, in one file here:
const math = { add: (a, b) => a + b, PI: 3.14159 };
module.exports = math;
console.log(math.add(2, 3), math.PI);`,
        explain: 'Modern JavaScript uses `export` / `import` (ES modules). Older Node code uses `module.exports` / `require()`. Either way, each file exposes only what it exports.',
        run: { out: '5 3.14159\n' },
      },
    },
  },
  {
    task: 'C++ vectors and maps',
    asks: ['c++ vector example', 'c++ map example', 'how do i use a list in c++', 'count words in c++'],
    impls: {
      cpp: {
        code: `#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

int main() {
    std::vector<int> numbers = {5, 3, 8};
    numbers.push_back(1);
    int sum = 0;
    for (int n : numbers) sum += n;
    std::cout << "count " << numbers.size() << ", sum " << sum << "\\n";

    std::map<std::string, int> counts;
    std::istringstream words("the cat and the hat");
    std::string word;
    while (words >> word) counts[word]++;
    for (const auto& [w, c] : counts) std::cout << w << " " << c << "\\n";
    return 0;
}`,
        explain: '`std::vector` is a growable array; `std::map` keeps keys sorted and `counts[word]++` starts missing keys at 0. The range `for` loop and structured bindings (`auto& [w, c]`) keep it short.',
        run: { out: 'count 4, sum 17\nand 1\ncat 1\nhat 1\nthe 2\n' },
      },
    },
  },
  {
    task: 'a C++ class',
    asks: ['c++ class example', 'object oriented c++', 'write a class in c++'],
    impls: {
      cpp: {
        code: `#include <iostream>
#include <string>

class Rectangle {
public:
    Rectangle(double width, double height) : width_(width), height_(height) {}
    double area() const { return width_ * height_; }
    std::string describe() const {
        return std::to_string(static_cast<int>(width_)) + "x" + std::to_string(static_cast<int>(height_));
    }

private:
    double width_;
    double height_;
};

int main() {
    Rectangle r(3, 4);
    std::cout << r.describe() << " has area " << r.area() << "\\n";
    return 0;
}`,
        explain: 'Data is `private`, methods are `public`; the constructor’s initializer list sets the fields, and `const` methods promise not to change the object.',
        run: { out: '3x4 has area 12\n' },
      },
    },
  },
  {
    task: 'Swift basics',
    asks: ['swift example', 'how do i write swift', 'swift struct and array', 'learn swift'],
    impls: {
      swift: {
        code: `struct Pet {
    let name: String
    var age: Int

    func describe() -> String {
        return "\\(name) is \\(age)"
    }
}

var pets = [Pet(name: "Rex", age: 3), Pet(name: "Tom", age: 5)]
pets.append(Pet(name: "Kiwi", age: 1))

for pet in pets.sorted(by: { $0.age < $1.age }) {
    print(pet.describe())
}

let ages = pets.map { $0.age }
print("total age:", ages.reduce(0, +))`,
        explain: '`struct`s hold data with `let` (constant) and `var` (changeable) properties. `\\(…)` puts values into strings, and closures like `{ $0.age < $1.age }` are short inline functions.',
        run: { out: 'Kiwi is 1\nRex is 3\nTom is 5\ntotal age: 9\n' },
      },
    },
  },
  {
    task: 'Ruby basics',
    asks: ['ruby example', 'how do i write ruby', 'ruby hash and array'],
    impls: {
      ruby: {
        code: `scores = { "Ada" => 92, "Linus" => 85, "Grace" => 97 }
scores["Alan"] = 88

scores.sort_by { |_name, score| -score }.each do |name, score|
  puts "#{name}: #{score}"
end

puts "average: #{scores.values.sum / scores.size.to_f}"`,
        explain: 'A hash maps keys to values; blocks (`{ |x| … }` or `do … end`) are passed to methods like `sort_by` and `each`. `#{…}` interpolates values into strings.',
        run: { out: 'Grace: 97\nAda: 92\nAlan: 88\nLinus: 85\naverage: 90.5\n' },
      },
    },
  },
  {
    task: 'Hello World and basics in Java',
    asks: ['hello world in java', 'java example', 'how do i start with java', 'java class and main method'],
    impls: {
      java: {
        code: `import java.util.ArrayList;
import java.util.List;

public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");

        List<String> names = new ArrayList<>();
        names.add("Ada");
        names.add("Linus");
        for (String name : names) {
            System.out.println("Hi " + name);
        }
    }
}`,
        explain: 'Every Java program starts in `public static void main`. Save it as `Main.java` (the file name must match the public class), then `javac Main.java` and `java Main`.',
        run: { unverified: true },
      },
    },
  },
  {
    task: 'Hello World and basics in Go',
    asks: ['hello world in go', 'go example', 'golang basics'],
    impls: {
      go: {
        code: `package main

import "fmt"

func main() {
	fmt.Println("Hello, World!")

	scores := map[string]int{"Ada": 92, "Linus": 85}
	for name, score := range scores {
		fmt.Printf("%s scored %d\\n", name, score)
	}
}`,
        explain: 'Go programs start in `func main` in package `main`. `:=` declares and assigns, and `range` loops over maps and slices (map order is random). Run it with `go run main.go`.',
        run: { unverified: true },
      },
    },
  },
  {
    task: 'Hello World and basics in Rust',
    asks: ['hello world in rust', 'rust example', 'rust basics'],
    impls: {
      rust: {
        code: `fn main() {
    println!("Hello, World!");

    let mut numbers = vec![3, 1, 2];
    numbers.sort();
    let total: i32 = numbers.iter().sum();
    println!("{:?} sum to {}", numbers, total);
}`,
        explain: 'Variables are immutable unless marked `mut`. `vec![]` makes a growable list, and `{:?}` prints debug output. Build and run with `cargo run` (or `rustc main.rs`).',
        run: { unverified: true },
      },
    },
  },
  {
    task: 'Hello World in TypeScript',
    asks: ['typescript example', 'what is typescript', 'types in typescript'],
    impls: {
      typescript: {
        code: `interface User {
  name: string;
  age: number;
  email?: string; // optional
}

function greet(user: User): string {
  return \`Hi \${user.name}, you are \${user.age}\`;
}

const ada: User = { name: 'Ada', age: 36 };
console.log(greet(ada));`,
        explain: 'TypeScript is JavaScript plus types: an `interface` describes an object’s shape, and the compiler catches mistakes (like a missing `age`) before the code runs. Compile with `tsc`, or run it with a tool like `tsx`.',
        run: { unverified: true },
      },
    },
  },
];
