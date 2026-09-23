'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EditorBuffer } = require('../src/pyedit');
const { tokenizeLine, computeStates, renderSlice } = require('../src/pyhighlight');
const { KeyReader } = require('../src/keys');
const ansi = require('../src/ansi');

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok - ${name}\n  ${e.message}`);
  }
}

// --- editor buffer ----------------------------------------------------------

function bufferAt(text, row, col) {
  const b = new EditorBuffer(text);
  b.row = row;
  b.col = col;
  return b;
}

test('inserting text and reading it back', () => {
  const b = new EditorBuffer('');
  b.insert('print("hi")');
  assert.strictEqual(b.text, 'print("hi")');
  assert.strictEqual(b.col, 11);
  assert.ok(b.modified);
});

test('enter keeps the current indentation', () => {
  const b = bufferAt('    x = 1', 0, 9);
  b.newline();
  assert.deepStrictEqual(b.lines, ['    x = 1', '    ']);
  assert.strictEqual(b.col, 4);
});

test('enter adds a level after a colon', () => {
  const b = bufferAt('def f():', 0, 8);
  b.newline();
  assert.deepStrictEqual(b.lines, ['def f():', '    ']);
  assert.strictEqual(b.col, 4);
});

test('enter adds a level after an opening bracket', () => {
  const b = bufferAt('items = [', 0, 9);
  b.newline();
  assert.strictEqual(b.lines[1], '    ');
});

test('a trailing comment does not trigger an indent', () => {
  const b = bufferAt('x = 1  # set x', 0, 14);
  b.newline();
  assert.strictEqual(b.lines[1], '');
});

test('enter splits the line and carries the tail', () => {
  const b = bufferAt('  ab', 0, 3);
  b.newline();
  assert.deepStrictEqual(b.lines, ['  a', '  b']);
});

test('backspace removes a whole indent stop', () => {
  const b = bufferAt('        x', 0, 8);
  b.backspace();
  assert.strictEqual(b.line, '    x');
  assert.strictEqual(b.col, 4);
});

test('backspace removes one character in ordinary text', () => {
  const b = bufferAt('abcd', 0, 4);
  b.backspace();
  assert.strictEqual(b.line, 'abc');
});

test('backspace at column zero joins with the previous line', () => {
  const b = bufferAt('one\ntwo', 1, 0);
  b.backspace();
  assert.deepStrictEqual(b.lines, ['onetwo']);
  assert.strictEqual(b.col, 3);
});

test('delete removes forward and joins lines', () => {
  const b = bufferAt('abc', 0, 1);
  b.deleteChar();
  assert.strictEqual(b.line, 'ac');

  const j = bufferAt('a\nb', 0, 1);
  j.deleteChar();
  assert.deepStrictEqual(j.lines, ['ab']);
});

test('indent and dedent by four spaces', () => {
  const b = bufferAt('x = 1', 0, 0);
  b.indent();
  assert.strictEqual(b.line, '    x = 1');
  b.dedent();
  assert.strictEqual(b.line, 'x = 1');
  b.dedent();
  assert.strictEqual(b.line, 'x = 1');
});

test('toggling a comment on and off', () => {
  const b = bufferAt('    x = 1', 0, 0);
  b.toggleComment();
  assert.strictEqual(b.line, '    # x = 1');
  b.toggleComment();
  assert.strictEqual(b.line, '    x = 1');
});

test('cut and paste a line', () => {
  const b = bufferAt('a\nb\nc', 1, 0);
  b.cutLine();
  assert.deepStrictEqual(b.lines, ['a', 'c']);
  b.paste();
  assert.deepStrictEqual(b.lines, ['a', 'b', 'c']);
});

test('consecutive cuts accumulate into one block', () => {
  const b = bufferAt('a\nb\nc', 0, 0);
  b.cutLine();
  b.lastWasCut = true;
  b.cutLine();
  assert.deepStrictEqual(b.lines, ['c']);
  assert.deepStrictEqual(b.cutBuffer, ['a', 'b']);
  b.paste();
  assert.deepStrictEqual(b.lines, ['a', 'b', 'c']);
});

test('cutting the only line leaves an empty buffer', () => {
  const b = new EditorBuffer('only');
  b.cutLine();
  assert.deepStrictEqual(b.lines, ['']);
});

test('undo and redo', () => {
  const b = new EditorBuffer('start');
  b.col = 5;
  b.insert('!');
  assert.strictEqual(b.text, 'start!');
  assert.ok(b.undo());
  assert.strictEqual(b.text, 'start');
  assert.ok(b.redo());
  assert.strictEqual(b.text, 'start!');
  b.undo();
  assert.strictEqual(b.undo(), false);
});

test('search finds forward and wraps around', () => {
  const b = new EditorBuffer('alpha\nbeta\ngamma');
  assert.deepStrictEqual(b.find('beta', 0, 0), { row: 1, col: 0 });
  assert.deepStrictEqual(b.find('alpha', 2, 0), { row: 0, col: 0 });
  assert.strictEqual(b.find('zzz', 0, 0), null);
});

test('home toggles between indent and column zero', () => {
  const b = bufferAt('    x', 0, 5);
  b.home();
  assert.strictEqual(b.col, 4);
  b.home();
  assert.strictEqual(b.col, 0);
});

test('goto line clamps to the document', () => {
  const b = new EditorBuffer('a\nb\nc');
  b.gotoLine(2);
  assert.strictEqual(b.row, 1);
  b.gotoLine(999);
  assert.strictEqual(b.row, 2);
});

test('cursor movement crosses line boundaries', () => {
  const b = bufferAt('ab\ncd', 0, 2);
  b.moveRight();
  assert.deepStrictEqual([b.row, b.col], [1, 0]);
  b.moveLeft();
  assert.deepStrictEqual([b.row, b.col], [0, 2]);
});

// --- python highlighting ----------------------------------------------------

function spanText(line, state) {
  return tokenizeLine(line, state).spans.map((s) => s.text).join('');
}

function classOf(line, word) {
  const span = tokenizeLine(line).spans.find((s) => s.text === word);
  return span ? span.cls : null;
}

test('tokenising preserves the whole line', () => {
  const samples = [
    'def greet(name):',
    '    return f"hi {name}"',
    'x = [1, 2, 3]  # a list',
    '@decorator',
    'if x is not None and y == 3:',
    "s = 'unterminated",
    '',
    '        ',
    'a="x";b=\'y\'',
  ];
  for (const s of samples) {
    assert.strictEqual(spanText(s), s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test('keywords, builtins, constants and names are classified', () => {
  assert.strictEqual(classOf('def greet():', 'def'), 'kw');
  assert.strictEqual(classOf('def greet():', 'greet'), 'defname');
  assert.strictEqual(classOf('class Foo:', 'Foo'), 'defname');
  assert.strictEqual(classOf('print(x)', 'print'), 'builtin');
  assert.strictEqual(classOf('x = None', 'None'), 'const');
  assert.strictEqual(classOf('x = 42', '42'), 'num');
});

test('comments and strings are classified', () => {
  assert.strictEqual(classOf('x = 1  # note', '# note'), 'comment');
  assert.strictEqual(classOf('s = "text"', '"text"'), 'str');
  assert.strictEqual(classOf("s = 'text'", "'text'"), 'str');
  assert.strictEqual(classOf('@app.route', '@app.route'), 'decorator');
});

test('a hash inside a string is not a comment', () => {
  const spans = tokenizeLine('s = "a # b"').spans;
  assert.ok(spans.some((s) => s.cls === 'str' && s.text === '"a # b"'));
  assert.ok(!spans.some((s) => s.cls === 'comment'));
});

test('triple-quoted strings carry state across lines', () => {
  const lines = ['"""doc', 'still docstring', 'end"""', 'x = 1'];
  const states = computeStates(lines);
  assert.strictEqual(states[0], null);
  assert.ok(states[1], 'line 2 should be inside a string');
  assert.ok(states[2], 'line 3 should be inside a string');
  assert.strictEqual(states[3], null, 'line 4 should be back in code');
  assert.strictEqual(spanText(lines[1], states[1]), lines[1]);
});

test('a one-line triple-quoted string does not leak state', () => {
  assert.strictEqual(computeStates(['"""doc"""', 'x = 1'])[1], null);
});

test('f-string and raw prefixes stay part of the string', () => {
  const spans = tokenizeLine('s = f"hi {n}"').spans;
  const joined = spans.filter((s) => s.cls === 'str').map((s) => s.text).join('');
  assert.strictEqual(joined, 'f"hi {n}"');
});

test('renderSlice returns the requested columns', () => {
  ansi.setEnabled(false);
  assert.strictEqual(renderSlice('abcdef', null, 0, 3), 'abc');
  assert.strictEqual(renderSlice('abcdef', null, 2, 5), 'cde');
  assert.strictEqual(renderSlice('x = 1', null, 0, 99), 'x = 1');
});

test('renderSlice emits colour when enabled', () => {
  ansi.setEnabled(true);
  const painted = renderSlice('def f():', null, 0, 99);
  assert.ok(painted.includes('\x1b['), 'expected escapes');
  assert.strictEqual(ansi.strip(painted), 'def f():');
  ansi.setEnabled(false);
});

// --- key reader -------------------------------------------------------------

test('key reader decodes escape sequences and control keys', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxkeys-')), 'keys.bin');
  const bytes = Buffer.concat([
    Buffer.from('a'),
    Buffer.from('\x1b[A'), Buffer.from('\x1b[B'), Buffer.from('\x1b[C'), Buffer.from('\x1b[D'),
    Buffer.from('\x01'),
    Buffer.from('\x7f'),
    Buffer.from('\r'),
    Buffer.from('\t'),
    Buffer.from('\x1b[3~'), Buffer.from('\x1b[5~'), Buffer.from('\x1b[6~'),
    Buffer.from('\x1b[H'), Buffer.from('\x1b[F'),
    Buffer.from('\x1b[Z'),
    Buffer.from('\x1bb'),
    Buffer.from('é', 'utf8'),
  ]);
  fs.writeFileSync(file, bytes);

  const fd = fs.openSync(file, 'r');
  const reader = new KeyReader(fd);
  const got = [];
  for (let i = 0; i < 17; i++) {
    const k = reader.next();
    if (k.name === 'eof') break;
    got.push(k);
  }
  fs.closeSync(fd);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });

  const names = got.map((k) => k.name);
  assert.deepStrictEqual(names, [
    'a', 'up', 'down', 'right', 'left', 'a', 'backspace', 'return', 'tab',
    'delete', 'pageup', 'pagedown', 'home', 'end', 'tab', 'b', 'é',
  ]);
  assert.ok(got[0].printable, 'plain characters should be printable');
  assert.ok(got[5].ctrl, 'ctrl-a should be flagged ctrl');
  assert.ok(got[14].shift, 'shift-tab should be flagged shift');
  assert.ok(got[15].meta, 'meta-b should be flagged meta');
  assert.strictEqual(got[16].str, 'é');
});

if (failures) {
  console.error(`\n${failures} pyedit test(s) failed`);
  process.exit(1);
}
console.log('\nall pyedit tests passed');
