'use strict';

const assert = require('assert');
const { Interpreter } = require('../src/interpreter');

function run(source) {
  const lines = [];
  const interp = new Interpreter({ output: (s) => lines.push(s) });
  interp.run(source);
  return lines;
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`not ok - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

test('variables and arithmetic', () => {
  assert.deepStrictEqual(run('let x = 2 + 3 * 4\nprint x'), ['14']);
});

test('string concatenation', () => {
  assert.deepStrictEqual(run('print "a" + "b" + "c"'), ['abc']);
});

test('functions and recursion', () => {
  const src = `
    fn fib(n) do
      if n < 2 do
        return n
      end
      return fib(n - 1) + fib(n - 2)
    end
    print fib(7)
  `;
  assert.deepStrictEqual(run(src), ['13']);
});

test('while loop mutates outer binding', () => {
  const src = `
    let i = 0
    let sum = 0
    while i < 5 do
      let sum = sum + i
      let i = i + 1
    end
    print sum
  `;
  assert.deepStrictEqual(run(src), ['10']);
});

test('if / else if / else', () => {
  const src = `
    fn classify(n) do
      if n > 10 do
        return "big"
      else if n > 0 do
        return "medium"
      else
        return "small"
      end
    end
    print classify(20)
    print classify(5)
    print classify(-1)
  `;
  assert.deepStrictEqual(run(src), ['big', 'medium', 'small']);
});

test('bare commands run as real shell commands, no "!" needed', () => {
  assert.deepStrictEqual(run('echo hello-from-shell'), ['hello-from-shell']);
});

test('cd accepts bareword and ".." paths', () => {
  const path = require('path');
  const src = `
    cd test
    pwd
    cd ..
    pwd
  `;
  const [afterCd, afterCdDotDot] = run(src);
  assert.strictEqual(afterCd, path.resolve(__dirname));
  assert.strictEqual(afterCdDotDot, path.resolve(__dirname, '..'));
});

test('calling a defined function at top level needs no prefix', () => {
  const src = `
    fn greet(n) do
      print "hi " + n
    end
    greet("max")
  `;
  assert.deepStrictEqual(run(src), ['hi max']);
});

test('array literals and indexing', () => {
  assert.deepStrictEqual(run('let arr = [10, 20, 30]\nprint arr\nprint arr[1]\nprint len(arr)'),
    ['[10, 20, 30]', '20', '3']);
});

test('for-in loop over an array', () => {
  const src = `
    let total = 0
    for x in [1, 2, 3, 4] do
      let total = total + x
    end
    print total
  `;
  assert.deepStrictEqual(run(src), ['10']);
});

test('for-in loop over range() with break and continue', () => {
  const src = `
    for i in range(10) do
      if i == 5 do
        break
      end
      if i % 2 == 0 do
        continue
      end
      print i
    end
  `;
  assert.deepStrictEqual(run(src), ['1', '3']);
});

test('break outside a loop reports an error, not a crash', () => {
  const interp = new Interpreter({ output: () => {} });
  assert.throws(() => interp.run('break'), /'break' used outside of a loop/);
});

test('builtin string and math functions', () => {
  const src = `
    print upper("hi")
    print lower("HI")
    print abs(-5)
    print max(3, 9, 1)
    print min(3, 9, 1)
    print sqrt(16)
    print split("a,b,c", ",")
    print join([1, 2, 3], "-")
  `;
  assert.deepStrictEqual(run(src), ['HI', 'hi', '5', '9', '1', '4', '[a, b, c]', '1-2-3']);
});

test('which identifies keywords, functions, and variables', () => {
  const src = `
    fn greet(n) do
      print n
    end
    let x = 42
    which cd
    which greet
    which x
  `;
  assert.deepStrictEqual(run(src), [
    'cd: maxshell keyword',
    'greet: function',
    'x: variable = 42',
  ]);
});

test('alias expands the leading word of a shell command', () => {
  assert.deepStrictEqual(run('alias hi = "echo aliased"\nhi'), ['aliased']);
});

test('env sets and reads a variable used by real commands', () => {
  const src = `
    env MAXSHELL_TEST_VAR = "from-maxscript"
    echo $MAXSHELL_TEST_VAR
  `;
  assert.deepStrictEqual(run(src), ['from-maxscript']);
});

test('history records real commands, not MaxScript statements', () => {
  const src = `
    let x = 1
    echo one
    echo two
    history
  `;
  assert.deepStrictEqual(run(src), ['one', 'two', '1  echo one', '2  echo two']);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
