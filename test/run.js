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

if (process.exitCode) {
  process.exit(process.exitCode);
}
