'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EditorBuffer, PyEditor } = require('../src/pyedit');
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
  assert.strictEqual(b.clipboard.text, 'a\nb');
  assert.strictEqual(b.clipboard.linewise, true);
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


// --- noticing changes made by other programs --------------------------------

function tempEditor(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxedit-'));
  const file = path.join(dir, 'thing.py');
  fs.writeFileSync(file, initial);
  const shell = {
    cwd: dir,
    env: process.env,
    options: new Set(),
    resolve: (f) => (path.isAbsolute(f) ? f : path.join(dir, f)),
    writeTo() {},
  };
  const editor = new PyEditor({ shell, io: {}, filename: file, text: initial });
  editor.diskSig = `${fs.statSync(file).mtimeMs}:${fs.statSync(file).size}`;
  return { editor, file, dir };
}

// mtime resolution is coarse, so nudge it to guarantee a different signature.
function writeExternally(file, text) {
  fs.writeFileSync(file, text);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later);
}

test('an untouched buffer reloads when the file changes on disk', () => {
  const { editor, file, dir } = tempEditor('x = 1\n');
  writeExternally(file, 'x = 99\ny = 2\n');

  assert.strictEqual(editor.checkDisk(true), true, 'should report a change');
  assert.strictEqual(editor.buf.text, 'x = 99\ny = 2\n');
  assert.strictEqual(editor.diskChanged, false);
  assert.match(editor.message, /reloaded/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a modified buffer is not clobbered by a change on disk', () => {
  const { editor, file, dir } = tempEditor('x = 1\n');
  editor.buf.col = 0;
  editor.buf.insert('# mine\n');
  const mine = editor.buf.text;

  writeExternally(file, 'theirs = True\n');
  assert.strictEqual(editor.checkDisk(true), true);
  assert.strictEqual(editor.buf.text, mine, 'my edits must survive');
  assert.strictEqual(editor.diskChanged, true);
  assert.match(editor.message, /changed on disk/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('saving over a changed file asks first', () => {
  const { editor, file, dir } = tempEditor('x = 1\n');
  editor.buf.col = 0;
  editor.buf.insert('mine = 1\n');
  writeExternally(file, 'theirs = 1\n');
  editor.checkDisk(true);

  editor.save();
  assert.strictEqual(editor.mode, 'prompt', 'expected a confirmation prompt');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'theirs = 1\n', 'must not write yet');

  // Decline: their version stays.
  editor.handleKey({ name: 'n', printable: true, str: 'n' });
  editor.handleKey({ name: 'return' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'theirs = 1\n');
  assert.match(editor.message, /not saved/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('confirming the overwrite writes the buffer', () => {
  const { editor, file, dir } = tempEditor('x = 1\n');
  editor.buf.col = 0;
  editor.buf.insert('mine = 1\n');
  writeExternally(file, 'theirs = 1\n');
  editor.checkDisk(true);

  editor.save();
  editor.handleKey({ name: 'y', printable: true, str: 'y' });
  editor.handleKey({ name: 'return' });

  assert.ok(fs.readFileSync(file, 'utf8').startsWith('mine = 1'));
  assert.strictEqual(editor.buf.modified, false);
  assert.strictEqual(editor.diskChanged, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('our own save does not look like an external change', () => {
  const { editor, file, dir } = tempEditor('x = 1\n');
  editor.buf.col = 0;
  editor.buf.insert('y = 2\n');
  editor.save();
  assert.strictEqual(editor.mode, 'edit', 'a clean save should not prompt');
  assert.strictEqual(editor.checkDisk(true), false, 'no phantom reload after saving');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a deleted file is reported rather than blanking the buffer', () => {
  const { editor, file, dir } = tempEditor('keep = 1\n');
  fs.rmSync(file);
  assert.strictEqual(editor.checkDisk(true), true);
  assert.strictEqual(editor.buf.text, 'keep = 1\n');
  assert.match(editor.message, /no longer on disk/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('reload is throttled but force bypasses it', () => {
  const { editor, file, dir } = tempEditor('a = 1\n');
  editor.lastCheck = Date.now();
  writeExternally(file, 'a = 2\n');
  assert.strictEqual(editor.checkDisk(), false, 'throttled call should do nothing');
  assert.strictEqual(editor.checkDisk(true), true, 'forced call should notice');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the key reader can time out so idle polling works', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxkeys2-')), 'empty.bin');
  fs.writeFileSync(file, '');
  const fd = fs.openSync(file, 'r');
  const reader = new KeyReader(fd);
  // A regular file reports EOF rather than EAGAIN, so this must not hang.
  assert.strictEqual(reader.next(50).name, 'eof');
  fs.closeSync(fd);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});


// --- selection and block editing --------------------------------------------

function selected(text, from, to) {
  const b = new EditorBuffer(text);
  b.row = from[0]; b.col = from[1];
  b.setMark();
  b.row = to[0]; b.col = to[1];
  return b;
}

test('no selection until the cursor leaves the mark', () => {
  const b = new EditorBuffer('abc');
  assert.strictEqual(b.selectionRange(), null);
  b.setMark();
  assert.strictEqual(b.selectionRange(), null, 'an empty region is not a selection');
  b.col = 2;
  assert.ok(b.selectionRange());
});

test('the selection is ordered however it was made', () => {
  const forward = selected('hello', [0, 1], [0, 4]);
  const backward = selected('hello', [0, 4], [0, 1]);
  assert.deepStrictEqual(forward.selectionRange(), backward.selectionRange());
  assert.strictEqual(forward.selectedText(), 'ell');
  assert.strictEqual(backward.selectedText(), 'ell');
});

test('selected text spans lines', () => {
  const b = selected('one\ntwo\nthree', [0, 1], [2, 2]);
  assert.strictEqual(b.selectedText(), 'ne\ntwo\nth');
});

test('deleting a selection joins the remainder', () => {
  const b = selected('one\ntwo\nthree', [0, 1], [2, 2]);
  assert.strictEqual(b.deleteSelection(), true);
  assert.deepStrictEqual(b.lines, ['oree']);
  assert.deepStrictEqual([b.row, b.col], [0, 1]);
  assert.strictEqual(b.mark, null, 'the mark is consumed');
});

test('toggleMark reports and clears', () => {
  const b = new EditorBuffer('x');
  assert.strictEqual(b.toggleMark(), true);
  assert.strictEqual(b.toggleMark(), false);
  assert.strictEqual(b.mark, null);
});

test('Tab indents every selected line', () => {
  const b = selected('a = 1\nb = 2\nc = 3', [0, 0], [1, 1]);
  b.indent();
  assert.deepStrictEqual(b.lines, ['    a = 1', '    b = 2', 'c = 3']);
});

test('Shift-Tab dedents every selected line', () => {
  const b = selected('    a = 1\n    b = 2\nc = 3', [0, 0], [1, 1]);
  b.dedent();
  assert.deepStrictEqual(b.lines, ['a = 1', 'b = 2', 'c = 3']);
});

test('block indent skips blank lines', () => {
  const b = selected('a = 1\n\nb = 2', [0, 0], [2, 1]);
  b.indent();
  assert.deepStrictEqual(b.lines, ['    a = 1', '', '    b = 2']);
});

test('dedent with nothing to remove does not stack an undo', () => {
  const b = new EditorBuffer('a = 1');
  const depth = b.undoStack.length;
  b.dedent();
  assert.strictEqual(b.undoStack.length, depth);
  assert.strictEqual(b.lines[0], 'a = 1');
});

test('block comment comments all, then uncomments all', () => {
  const b = selected('a = 1\nb = 2', [0, 0], [1, 1]);
  b.toggleComment();
  assert.deepStrictEqual(b.lines, ['# a = 1', '# b = 2']);
  b.toggleComment();
  assert.deepStrictEqual(b.lines, ['a = 1', 'b = 2']);
});

test('a partly commented block is commented, not uncommented', () => {
  const b = selected('# a = 1\nb = 2', [0, 0], [1, 1]);
  b.toggleComment();
  assert.deepStrictEqual(b.lines, ['# a = 1', '# b = 2']);
});

test('cutting a selection is character-wise and pastes back', () => {
  const b = selected('one\ntwo', [0, 1], [1, 1]);
  b.cutLine();
  assert.deepStrictEqual(b.lines, ['owo']);
  assert.strictEqual(b.clipboard.linewise, false);
  assert.strictEqual(b.clipboard.text, 'ne\nt');
  b.paste();
  assert.deepStrictEqual(b.lines, ['one\ntwo'.split('\n')[0], 'two']);
});

test('copy without a selection takes the whole line', () => {
  const b = new EditorBuffer('alpha\nbeta');
  assert.deepStrictEqual(b.copy(), { text: 'alpha', linewise: true });
});

test('typing replaces nothing but drops the mark', () => {
  const b = selected('abcd', [0, 0], [0, 2]);
  b.insert('X');
  assert.strictEqual(b.mark, null);
});

test('backspace and delete remove the selection when there is one', () => {
  const back = selected('abcdef', [0, 1], [0, 4]);
  back.backspace();
  assert.strictEqual(back.text, 'aef');

  const del = selected('abcdef', [0, 1], [0, 4]);
  del.deleteChar();
  assert.strictEqual(del.text, 'aef');
});

test('matching brackets are found in both directions', () => {
  const b = new EditorBuffer('f(a, (b, c))');
  assert.deepStrictEqual(b.findMatch(0, 1), { row: 0, col: 11 });
  assert.deepStrictEqual(b.findMatch(0, 11), { row: 0, col: 1 });
  assert.deepStrictEqual(b.findMatch(0, 5), { row: 0, col: 10 });
  assert.strictEqual(b.findMatch(0, 0), null, 'not a bracket');
});

test('matching brackets span lines, and unbalanced ones return null', () => {
  const b = new EditorBuffer('items = [\n    1,\n]');
  assert.deepStrictEqual(b.findMatch(0, 8), { row: 2, col: 0 });
  assert.strictEqual(new EditorBuffer('f(a').findMatch(0, 1), null);
});

test('the editor paints the selection and the bracket pair', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxsel-'));
  const shell = { cwd: dir, env: process.env, options: new Set(), resolve: (f) => f, writeTo() {} };
  const editor = new PyEditor({ shell, io: {}, filename: '', text: 'f(x)\ny = 1' });

  editor.buf.row = 0; editor.buf.col = 0;
  editor.buf.setMark();
  editor.buf.row = 1; editor.buf.col = 1;
  editor.bracketPair = null;
  const first = editor.rowRanges(0);
  assert.deepStrictEqual(first, [[0, 5]], 'a fully selected row runs past its end');
  assert.deepStrictEqual(editor.rowRanges(1), [[0, 1]]);

  editor.buf.clearMark();
  editor.buf.row = 0; editor.buf.col = 1;
  editor.bracketPair = editor.bracketHighlight();
  assert.deepStrictEqual(editor.rowRanges(0), [[1, 2], [3, 4]], 'both brackets highlighted');

  fs.rmSync(dir, { recursive: true, force: true });
});


test('Tab indents the whole selection through the key bindings', () => {
  const shell = { cwd: '.', env: process.env, options: new Set(), resolve: (f) => f, writeTo() {} };
  const editor = new PyEditor({ shell, io: {}, filename: '', text: 'a = 1\nb = 2' });

  editor.handleKey({ name: 'a', meta: true, printable: true, str: 'a' });
  assert.ok(editor.buf.mark, 'M-A should set the mark');
  editor.handleKey({ name: 'down' });
  assert.ok(editor.buf.selectionRange(), 'moving should open a selection');
  editor.handleKey({ name: 'tab' });

  assert.deepStrictEqual(editor.buf.lines, ['    a = 1', '    b = 2']);
});

test('Tab without a selection still types an indent at the cursor', () => {
  const shell = { cwd: '.', env: process.env, options: new Set(), resolve: (f) => f, writeTo() {} };
  const editor = new PyEditor({ shell, io: {}, filename: '', text: 'ab' });
  editor.buf.col = 1;
  editor.handleKey({ name: 'tab' });
  assert.strictEqual(editor.buf.text, 'a    b');
});

test('Shift-Tab dedents the selected block through the key bindings', () => {
  const shell = { cwd: '.', env: process.env, options: new Set(), resolve: (f) => f, writeTo() {} };
  const editor = new PyEditor({ shell, io: {}, filename: '', text: '    a = 1\n    b = 2' });
  editor.handleKey({ name: 'a', meta: true, printable: true, str: 'a' });
  editor.handleKey({ name: 'down' });
  editor.handleKey({ name: 'tab', shift: true });
  assert.deepStrictEqual(editor.buf.lines, ['a = 1', 'b = 2']);
});

test('shift-arrow opens a selection without setting the mark first', () => {
  const shell = { cwd: '.', env: process.env, options: new Set(), resolve: (f) => f, writeTo() {} };
  const editor = new PyEditor({ shell, io: {}, filename: '', text: 'a = 1\nb = 2' });
  editor.handleKey({ name: 'down', shift: true });
  assert.ok(editor.buf.selectionRange(), 'shift-down should select');
  editor.handleKey({ name: 'tab' });
  assert.deepStrictEqual(editor.buf.lines, ['    a = 1', '    b = 2']);
});

if (failures) {
  console.error(`\n${failures} pyedit test(s) failed`);
  process.exit(1);
}
console.log('\nall pyedit tests passed');
