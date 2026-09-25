'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ansi = require('../src/ansi');
const syntax = require('../src/syntax');
const { EditorBuffer, PyEditor } = require('../src/pyedit');
const { Pager, PagerScreen } = require('../src/view');
const { FileBrowser, FilesScreen, previewOf, describe, isTextual, finderDate, finderLabel, middleTruncate, iconArt, ART_W, CELL_H } = require('../src/files');
const ops = require('../src/fileops');
const { ProcessTable, parsePs, coreUsage } = require('../src/top');
const { fit, humanBytes, meter } = require('../src/tui');

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

ansi.setEnabled(false);
const lang = (id) => syntax.languageById(id);
const joined = (l, line, state = null) => l.tokenize(line, state).spans.map((s) => s.text).join('');
const classOf = (l, line, text) => (l.tokenize(line).spans.find((s) => s.text === text) || {}).cls;

// --- syntax -----------------------------------------------------------------

test('every tokenizer reproduces its input exactly', () => {
  const samples = {
    javascript: ['const x = require("fs"); // hi', 'let s = `a ${b} c`;', '/* open', 'x = 0x1F + 2.5e3;', ''],
    shell: ['for f in *.js; do echo "$f ${#f}"; done', 'X=1 ls -la | grep a # c', "echo 'q' $(pwd)", ''],
    json: ['{"a": [1, -2.5e3, true, null], "b": "x"}', '  ', ''],
    markdown: ['# Title', '- a **b** `c` [d](e)', '> q', '1. item', '```js', ''],
    plain: ['anything at all', ''],
  };
  for (const [id, lines] of Object.entries(samples)) {
    for (const line of lines) assert.strictEqual(joined(lang(id), line), line, `${id}: ${JSON.stringify(line)}`);
  }
});

test('JavaScript tokens are classified', () => {
  const js = lang('javascript');
  assert.strictEqual(classOf(js, 'const x = 1', 'const'), 'kw');
  assert.strictEqual(classOf(js, 'return null', 'null'), 'const');
  assert.strictEqual(classOf(js, 'console.log(1)', 'console'), 'builtin');
  assert.strictEqual(classOf(js, 'function go() {}', 'go'), 'defname');
  assert.strictEqual(classOf(js, 'x = "s"', '"s"'), 'str');
  assert.strictEqual(classOf(js, 'x = 1 // note', '// note'), 'comment');
});

test('JavaScript block comments and template literals span lines', () => {
  const js = lang('javascript');
  const states = syntax.computeStates(js, ['a /* start', 'middle', 'end */ b', 'c']);
  assert.strictEqual(states[1].kind, 'block');
  assert.strictEqual(states[2].kind, 'block');
  assert.strictEqual(states[3], null);
  const t = syntax.computeStates(js, ['x = `one', 'two`', 'y']);
  assert.strictEqual(t[1].kind, 'template');
  assert.strictEqual(t[2], null);
});

test('shell tokens are classified', () => {
  const sh = lang('shell');
  assert.strictEqual(classOf(sh, 'if true; then', 'if'), 'kw');
  assert.strictEqual(classOf(sh, 'echo hi', 'echo'), 'builtin');
  assert.strictEqual(classOf(sh, 'ls -la', 'ls'), 'defname');
  assert.strictEqual(classOf(sh, 'ls -la', '-la'), 'decorator');
  assert.strictEqual(classOf(sh, 'echo $HOME', '$HOME'), 'var');
  assert.strictEqual(classOf(sh, 'NAME=v cmd', 'NAME'), 'var');
  assert.strictEqual(classOf(sh, 'x # c', '# c'), 'comment');
});

test('a # inside a shell word is not a comment', () => {
  const spans = lang('shell').tokenize('echo a#b').spans;
  assert.ok(!spans.some((s) => s.cls === 'comment'));
});

test('JSON keys differ from string values', () => {
  const j = lang('json');
  assert.strictEqual(classOf(j, '{"name": "max"}', '"name"'), 'key');
  assert.strictEqual(classOf(j, '{"name": "max"}', '"max"'), 'str');
  assert.strictEqual(classOf(j, '[true]', 'true'), 'const');
});

test('Markdown fenced code carries across lines', () => {
  const md = lang('markdown');
  const states = syntax.computeStates(md, ['text', '```py', 'x = 1', '```', '# after']);
  assert.strictEqual(states[2].kind, 'fence');
  assert.strictEqual(states[3].kind, 'fence');
  assert.strictEqual(states[4], null);
  assert.strictEqual(md.tokenize('# after').spans[0].cls, 'heading');
});

test('languages are detected by extension, #! line, and content', () => {
  const d = (f, first) => syntax.detectLanguage(f, first).id;
  assert.strictEqual(d('a.py'), 'python');
  assert.strictEqual(d('a.MJS'), 'javascript');
  assert.strictEqual(d('a.zsh'), 'shell');
  assert.strictEqual(d('demo.mxsh'), 'shell');
  assert.strictEqual(d('a.json'), 'json');
  assert.strictEqual(d('README.md'), 'markdown');
  assert.strictEqual(d('script', '#!/usr/bin/env python3'), 'python');
  assert.strictEqual(d('run', '#!/bin/bash'), 'shell');
  assert.strictEqual(d('notes'), 'plain');
  assert.strictEqual(syntax.sniffLanguage('{"a": 1}').id, 'json');
  assert.strictEqual(syntax.sniffLanguage('{not json').id, 'plain');
  assert.strictEqual(syntax.sniffLanguage('## Heading').id, 'markdown');
});

// --- the multi-language editor ----------------------------------------------

function buf(text, id, col) {
  const b = new EditorBuffer(text, { lang: lang(id) });
  b.col = col === undefined ? b.line.length : col;
  return b;
}

test('JavaScript: Enter indents after {, and opens up {}', () => {
  const b = buf('if (x) {', 'javascript');
  b.newline();
  assert.deepStrictEqual(b.lines, ['if (x) {', '    ']);
  const pair = buf('f() {}', 'javascript', 5);
  pair.newline();
  assert.deepStrictEqual(pair.lines, ['f() {', '    ', '}']);
  assert.deepStrictEqual([pair.row, pair.col], [1, 4]);
});

test('JavaScript: a // comment does not trigger an indent', () => {
  const b = buf('x = 1; // {', 'javascript');
  b.newline();
  assert.strictEqual(b.lines[1], '');
});

test('shell: Enter indents after then / do', () => {
  const t = buf('if true; then', 'shell');
  t.newline();
  assert.strictEqual(t.lines[1], '    ');
  const d = buf('for x in a b; do', 'shell');
  d.newline();
  assert.strictEqual(d.lines[1], '    ');
});

test('typing a closer into leading whitespace dedents it', () => {
  const b = buf('        ', 'javascript');
  b.typeChar('}');
  assert.strictEqual(b.line, '    }');
  const mid = buf('x = ', 'javascript');
  mid.typeChar('}');
  assert.strictEqual(mid.line, 'x = }', 'mid-line closers are just typed');
});

test('comment toggling uses each language’s marker', () => {
  const js = buf('a();\nb();', 'javascript', 0);
  js.setMark(); js.row = 1; js.col = 4;
  js.toggleComment();
  assert.deepStrictEqual(js.lines, ['// a();', '// b();']);
  js.toggleComment();
  assert.deepStrictEqual(js.lines, ['a();', 'b();']);

  const sh = buf('echo hi', 'shell', 0);
  sh.toggleComment();
  assert.strictEqual(sh.line, '# echo hi');

  const json = buf('{}', 'json', 0);
  assert.strictEqual(json.toggleComment(), false, 'JSON has no comments');
  assert.strictEqual(json.line, '{}');
});

test('Markdown gets no automatic indentation', () => {
  const b = buf('- item:', 'markdown');
  b.newline();
  assert.strictEqual(b.lines[1], '');
});

function stubShell(dir) {
  return {
    cwd: dir, env: process.env, options: new Set(), writeTo() {},
    resolve: (f) => (path.isAbsolute(f) ? f : path.join(dir, f)),
  };
}

test('the editor picks the language from the filename and titles it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxtools-'));
  const e = new PyEditor({ shell: stubShell(dir), io: {}, filename: 'app.js', text: 'let a = 1;' });
  assert.strictEqual(e.lang.id, 'javascript');
  assert.match(e.titleBar(), /\[JavaScript\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('syntax checks use each language’s own parser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxtools-'));
  const shell = stubShell(dir);
  const check = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return new PyEditor({ shell, io: {}, filename: file, text }).checkSyntax(file);
  };
  assert.strictEqual(check('ok.json', '{"a": 1}'), null);
  assert.match(check('bad.json', '{\n  "a": 1,\n}'), /line 3/);
  assert.strictEqual(check('ok.js', 'const a = 1;\n'), null);
  assert.match(check('bad.js', 'const = ;\n'), /SyntaxError.*line 1/);
  assert.strictEqual(check('ok.sh', 'if true; then echo y; fi\n'), null);
  assert.match(check('bad.sh', 'if true; then echo y\n'), /end of input|fi/);
  assert.strictEqual(check('notes.md', '# anything'), null, 'markdown is never checked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('^T runs JavaScript and shell buffers with the right interpreter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxtools-'));
  const shell = stubShell(dir);
  const run = (name, text) => {
    const e = new PyEditor({ shell, io: {}, filename: name, text });
    e.runBuffer();
    return e;
  };
  assert.ok(run('a.js', 'console.log(6 * 7)').view.includes('42'));
  assert.ok(run('a.sh', 'x=(a b c); echo "count=${#x}"').view.includes('count=3'));
  const md = run('a.md', '# hi');
  assert.match(md.message, /nothing to run/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- view -------------------------------------------------------------------

const hundred = Array.from({ length: 100 }, (_, i) => `line ${i}${i % 25 === 0 ? ' Match' : ''}`).join('\n');

test('the pager pages and clamps to the end', () => {
  const p = new Pager(`${hundred}\n`, { name: 'x.txt' });
  p.height = 20;
  assert.strictEqual(p.lines.length, 100, 'a trailing newline is not an extra line');
  p.pageDown();
  assert.strictEqual(p.top, 20);
  p.end();
  assert.strictEqual(p.top, 80);
  p.pageDown();
  assert.strictEqual(p.top, 80, 'cannot scroll past the end');
  p.home();
  assert.strictEqual(p.top, 0);
});

test('search is smart-case and navigation wraps', () => {
  const p = new Pager(hundred, { name: 'x.txt' });
  p.height = 10;
  assert.strictEqual(p.findAll('match'), 4, 'lowercase is case-insensitive');
  assert.strictEqual(p.findAll('MATCH'), 0, 'a capital makes it case-sensitive');
  p.findAll('Match');
  const rows = [p.nextMatch(1).row, p.nextMatch(1).row, p.nextMatch(1).row, p.nextMatch(1).row, p.nextMatch(1).row];
  assert.deepStrictEqual(rows, [0, 25, 50, 75, 0]);
  assert.strictEqual(p.nextMatch(-1).row, 75);
  assert.deepStrictEqual(p.matchesOnRow(25), [[8, 13]]);
});

test('the pager detects language from the name or the content', () => {
  assert.strictEqual(new Pager('x = 1', { name: 'a.py' }).lang.id, 'python');
  assert.strictEqual(new Pager('{"k": [1]}').lang.id, 'json');
});

test('follow mode reloads a growing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxtools-'));
  const file = path.join(dir, 'log.txt');
  fs.writeFileSync(file, 'one\n');
  const pager = new Pager('one\n', { name: 'log.txt' });
  const screen = new PagerScreen(pager, { file, output: { write() {}, rows: 10, columns: 40 } });
  pager.following = true;
  fs.appendFileSync(file, 'two\nthree\n');
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later);
  assert.strictEqual(screen.poll(), true);
  assert.deepStrictEqual(pager.lines, ['one', 'two', 'three']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pager keys: q quits, / searches, # toggles numbers', () => {
  const out = { data: '', write(s) { this.data += s; }, rows: 12, columns: 60 };
  const screen = new PagerScreen(new Pager(hundred, { name: 'x' }), { output: out });
  screen.handleKey({ name: '#', printable: true, str: '#' });
  assert.strictEqual(screen.pager.showNumbers, true);
  screen.handleKey({ name: '/', printable: true, str: '/' });
  for (const ch of 'line 42') screen.handleKey({ name: ch, printable: true, str: ch });
  screen.handleKey({ name: 'return' });
  assert.ok(screen.pager.top <= 42 && screen.pager.top + 10 > 42, 'the match is on screen');
  screen.render();
  assert.match(ansi.strip(out.data), /line 42/);
  screen.handleKey({ name: 'q', printable: true, str: 'q' });
  assert.strictEqual(screen.done, true);
});

// --- files ------------------------------------------------------------------

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxfiles-'));
  fs.mkdirSync(path.join(dir, 'beta'));
  fs.mkdirSync(path.join(dir, 'Alpha'));
  fs.writeFileSync(path.join(dir, 'beta', 'inner.txt'), 'inside\n');
  fs.writeFileSync(path.join(dir, 'zeta.py'), 'def f():\n    pass\n');
  fs.writeFileSync(path.join(dir, 'file10.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'file2.txt'), 'x');
  fs.writeFileSync(path.join(dir, '.hidden'), 'h');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
  return fs.realpathSync(dir);
}

test('directories first, then natural name order, hidden files hidden', () => {
  const dir = tree();
  const b = new FileBrowser(dir);
  assert.deepStrictEqual(b.visible().map((e) => e.name),
    ['Alpha', 'beta', 'blob.bin', 'file2.txt', 'file10.txt', 'zeta.py']);
  b.toggleHidden();
  assert.ok(b.visible().some((e) => e.name === '.hidden'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('entering and leaving a directory keeps your place', () => {
  const dir = tree();
  const b = new FileBrowser(dir);
  b.moveTo(1);
  assert.strictEqual(b.current.name, 'beta');
  assert.deepStrictEqual(b.enter(), { action: 'cd' });
  assert.strictEqual(b.cwd, path.join(dir, 'beta'));
  assert.strictEqual(b.current.name, 'inner.txt');
  b.up();
  assert.strictEqual(b.cwd, dir);
  assert.strictEqual(b.current.name, 'beta', 'the cursor returns to the folder you left');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('entering a file asks to open it', () => {
  const dir = tree();
  const b = new FileBrowser(dir);
  b.moveTo(5);
  const r = b.enter();
  assert.strictEqual(r.action, 'open');
  assert.strictEqual(r.entry.name, 'zeta.py');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('filtering narrows the list and keeps the cursor on its entry', () => {
  const dir = tree();
  const b = new FileBrowser(dir);
  b.moveTo(4);
  b.setFilter('file');
  assert.deepStrictEqual(b.visible().map((e) => e.name), ['file2.txt', 'file10.txt']);
  assert.strictEqual(b.current.name, 'file10.txt');
  b.setFilter('nothing-matches');
  assert.strictEqual(b.current, null);
  b.move(1);
  assert.strictEqual(b.cursor, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('previews: highlighted text, directory listings, binary files', () => {
  const dir = tree();
  const b = new FileBrowser(dir);
  const find = (n) => b.visible().find((e) => e.name === n);
  const py = previewOf(find('zeta.py'), 10);
  assert.strictEqual(py.lang.id, 'python');
  assert.deepStrictEqual(py.lines, ['def f():', '    pass', '']);
  assert.deepStrictEqual(previewOf(find('beta'), 10).lines, ['inner.txt']);
  assert.match(previewOf(find('blob.bin'), 10).lines[0], /binary/);
  assert.deepStrictEqual(previewOf(find('Alpha'), 10).lines, ['(empty)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable directory is reported, not fatal', () => {
  const b = new FileBrowser(os.tmpdir());
  assert.strictEqual(b.load('/definitely/not/here'), false);
  assert.match(b.error, /cannot open/);
  assert.strictEqual(b.cwd, os.tmpdir(), 'stays where it was');
});

// --- top --------------------------------------------------------------------

const PS = [
  '    1     0   0.0  0.1  12000 root     /sbin/launchd',
  '  501     1  45.5  3.2 900000 max      /Apps/Code.app/Electron --type=renderer',
  '  777   501   2.0 10.5 3000000 max     node bin/maxshell.js',
  'not a process line',
].join('\n');

test('ps output is parsed, keeping full command lines', () => {
  const rows = parsePs(PS);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[1].name, 'Electron');
  assert.strictEqual(rows[1].command, '/Apps/Code.app/Electron --type=renderer');
  assert.strictEqual(rows[2].rss, 3000000 * 1024);
});

test('sorting by cpu, memory, pid and name', () => {
  const t = new ProcessTable();
  t.update(parsePs(PS));
  assert.deepStrictEqual(t.visible().map((p) => p.pid), [501, 777, 1]);
  t.setSort('mem');
  assert.deepStrictEqual(t.visible().map((p) => p.pid), [777, 501, 1]);
  t.setSort('pid');
  assert.deepStrictEqual(t.visible().map((p) => p.pid), [1, 501, 777]);
  t.setSort('name');
  assert.deepStrictEqual(t.visible().map((p) => p.name), ['Electron', 'launchd', 'node']);
});

test('the selected process survives re-sorting and refreshes', () => {
  const t = new ProcessTable();
  t.update(parsePs(PS));
  t.setSort('pid');
  t.move(2);
  assert.strictEqual(t.current.pid, 777);
  t.setSort('cpu');
  assert.strictEqual(t.current.pid, 777);
  t.update(parsePs(PS).filter((p) => p.pid !== 1));
  assert.strictEqual(t.current.pid, 777);
});

test('filtering matches command, user or exact pid', () => {
  const t = new ProcessTable();
  t.update(parsePs(PS));
  t.setFilter('electron');
  assert.deepStrictEqual(t.visible().map((p) => p.pid), [501]);
  t.setFilter('root');
  assert.deepStrictEqual(t.visible().map((p) => p.pid), [1]);
  t.setFilter('777');
  assert.deepStrictEqual(t.visible().map((p) => p.pid), [777]);
});

test('core usage comes from cpu time deltas', () => {
  const t = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
  assert.deepStrictEqual(coreUsage([t(0, 0), t(0, 0)], [t(50, 50), t(100, 0)]), [0.5, 0]);
  assert.deepStrictEqual(coreUsage(null, [t(1, 1)]), [0]);
});

// --- shared helpers ---------------------------------------------------------

test('tui helpers', () => {
  assert.strictEqual(fit('abcdef', 4), 'abc…');
  assert.strictEqual(fit('ab', 4), 'ab  ');
  assert.strictEqual(humanBytes(512), '512B');
  assert.strictEqual(humanBytes(1536), '1.5K');
  assert.strictEqual(humanBytes(5 * 1024 * 1024 * 1024), '5.0G');
  assert.strictEqual(ansi.strip(meter(0.5, 12)), '[|||||     ]');
});

test('the tools refuse to run without a terminal', () => {
  const { Shell } = require('../src/interpreter');
  const errors = [];
  const sh = new Shell({ output: () => {}, error: (l) => errors.push(l) });
  sh.run('files; top; edit x.py');
  assert.ok(errors.some((l) => /files: needs an interactive terminal/.test(l)));
  assert.ok(errors.some((l) => /top: needs an interactive terminal/.test(l)));
  assert.ok(errors.some((l) => /edit: needs an interactive terminal/.test(l)));
});

test('view acts like cat when its output is not a terminal', () => {
  const { Shell } = require('../src/interpreter');
  const lines = [];
  const sh = new Shell({ output: (l) => lines.push(l), error: () => {} });
  sh.run('printf "a\\nb\\n" | view');
  assert.deepStrictEqual(lines, ['a', 'b']);
});


// --- C and C++ --------------------------------------------------------------

test('C and C++ are detected by extension', () => {
  const d = (f) => syntax.detectLanguage(f).id;
  for (const f of ['a.cpp', 'a.cc', 'a.cxx', 'a.hpp', 'a.hh', 'a.h', 'sketch.ino']) assert.strictEqual(d(f), 'cpp', f);
  assert.strictEqual(d('a.c'), 'c');
});

test('the C tokenizer reproduces its input and tracks block comments', () => {
  const cpp = lang('cpp');
  const lines = ['#include <vector>', '#define N 10', 'class W : public B {', "  int n = 1'000;",
    '  /* a', '     b */ char c = \'\\n\';', '  auto s = u8"x"; // c', '};', ''];
  const states = syntax.computeStates(cpp, lines);
  lines.forEach((l, i) => assert.strictEqual(joined(cpp, l, states[i]), l, JSON.stringify(l)));
  assert.strictEqual(states[5].kind, 'block');
  assert.strictEqual(states[6], null);
});

test('C++ tokens are classified', () => {
  const cpp = lang('cpp');
  assert.strictEqual(classOf(cpp, '#include <map>', '#include'), 'decorator');
  assert.strictEqual(classOf(cpp, '#include <map>', '<map>'), 'str');
  assert.strictEqual(classOf(cpp, 'struct Point {', 'Point'), 'defname');
  assert.strictEqual(classOf(cpp, 'template <typename T>', 'template'), 'kw');
  assert.strictEqual(classOf(cpp, 'unsigned long x;', 'unsigned'), 'builtin');
  assert.strictEqual(classOf(cpp, 'p = nullptr;', 'nullptr'), 'const');
  assert.strictEqual(classOf(cpp, "int n = 1'000'000;", "1'000'000"), 'num');
  assert.strictEqual(classOf(cpp, 'float f = 1.5f;', '1.5f'), 'num');
});

test('C++ editing: Enter opens {} and M-3 uses //', () => {
  const b = buf('int main() {}', 'cpp', 12);
  b.newline();
  assert.deepStrictEqual(b.lines, ['int main() {', '    ', '}']);
  const c = buf('x++;', 'cpp', 0);
  c.toggleComment();
  assert.strictEqual(c.line, '// x++;');
  assert.strictEqual(syntax.languageById('c').comment, '//');
});

const { findInPath } = require('../src/builtins');
const haveCompiler = !!(findInPath('c++', { env: process.env, resolve: (f) => f })
  && findInPath('cc', { env: process.env, resolve: (f) => f }));

test('C++ is checked on save and compiled and run with ^T', () => {
  if (!haveCompiler) { console.log('  (skipped: no C/C++ compiler)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxcpp-'));
  const shell = stubShell(dir);
  const open = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return { e: new PyEditor({ shell, io: {}, filename: file, text }), file };
  };

  const ok = open('ok.cpp', '#include <iostream>\nint main() { std::cout << 6 * 7 << "\\n"; }\n');
  assert.strictEqual(ok.e.checkSyntax(ok.file), null);
  ok.e.runBuffer();
  assert.ok(ok.e.view.includes('42'), JSON.stringify(ok.e.view));
  assert.match(ok.e.view[0], /exit 0/);

  const bad = open('bad.cpp', 'int main() {\n  int x = ;\n}\n');
  assert.match(bad.e.checkSyntax(bad.file), /error: .*\(line 2\)/);
  bad.e.runBuffer();
  assert.match(bad.e.view[0], /compile failed/);

  fs.writeFileSync(path.join(dir, 'local.h'), '#define ANSWER 7\n');
  const local = open('local.cpp', '#include "local.h"\n#include <cstdio>\nint main() { std::printf("%d\\n", ANSWER); }\n');
  local.e.runBuffer();
  assert.ok(local.e.view.includes('7'), 'a local #include resolves from the file\'s directory');

  const c = open('prog.c', '#include <stdio.h>\nint main(void) { puts("from C"); return 3; }\n');
  c.e.runBuffer();
  assert.ok(c.e.view.includes('from C'));
  assert.match(c.e.view[0], /exit 3/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('--lang accepts cpp and c', () => {
  const { LANG_ALIASES } = require('../src/pyedit');
  assert.strictEqual(LANG_ALIASES.cpp, 'cpp');
  assert.strictEqual(LANG_ALIASES['c++'], 'cpp');
  assert.strictEqual(LANG_ALIASES.c, 'c');
});


// --- files: the Finder-style browser ---------------------------------------------

const scratch = [];
process.on('exit', () => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

function finderTree() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mxfinder-')));
  scratch.push(dir);
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(work, 'photos'));
  fs.writeFileSync(path.join(work, 'notes.txt'), 'hello\n');
  fs.writeFileSync(path.join(work, 'big.py'), 'x = 1\n'.repeat(500));
  fs.writeFileSync(path.join(work, 'docs', 'deep-recipe.md'), '# soup\n');
  process.env.MAXSHELL_TRASH = path.join(dir, 'Trash');
  return { dir, work };
}

function finderScreen(work) {
  const out = { rows: 24, columns: 120, data: '', write(s) { this.data += s; } };
  return new FilesScreen(new FileBrowser(work), { shell: { cwd: work }, io: {}, output: out });
}

const press = (scr, name, extra = {}) => scr.handleKey({ name, ...extra });
const type = (scr, text) => { for (const ch of text) scr.handleKey({ name: ch, printable: true, str: ch }); };
const names = (scr) => scr.browser.visible().map((e) => e.name);
const select = (scr, name) => scr.browser.moveTo(scr.browser.visible().findIndex((e) => e.name === name));

test('kinds and icons follow Finder naming', () => {
  const k = (name, extra = {}) => describe({ name, path: name, ...extra }).kind;
  assert.strictEqual(k('a.py'), 'Python source');
  assert.strictEqual(k('a.cpp'), 'C++ source');
  assert.strictEqual(k('photo.JPG'), 'JPEG image');
  assert.strictEqual(k('stuff', { isDir: true }), 'Folder');
  assert.strictEqual(k('Safari.app', { isDir: true }), 'Application');
  assert.strictEqual(k('tool', { exec: true }), 'Unix executable');
  assert.strictEqual(k('data.xyz'), 'XYZ file');
  assert.strictEqual(describe({ name: 'a.py' }).icon, '🐍');
});

test('Enter edits text and code, and hands media to apps', () => {
  const { work } = finderTree();
  assert.strictEqual(isTextual({ name: 'notes.txt', path: path.join(work, 'notes.txt') }), true);
  assert.strictEqual(isTextual({ name: 'pic.png', path: '/nope.png' }), false);
  assert.strictEqual(isTextual({ name: 'docs', isDir: true }), false);
  const noExt = path.join(work, 'README');
  fs.writeFileSync(noExt, 'plain words');
  assert.strictEqual(isTextual({ name: 'README', path: noExt }), true, 'extensionless text is sniffed');
});

test('dates read like Finder', () => {
  assert.match(finderDate(Date.now()), /^Today at \d\d:\d\d$/);
  assert.match(finderDate(Date.now() - 86400000), /^Yesterday at/);
  assert.match(finderDate(new Date('2025-03-04T10:00:00').getTime()), /^Mar 4, 2025 at 10:00$/);
});

test('sorting cycles name, date, size, kind with folders on top', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  assert.deepStrictEqual(names(scr), ['docs', 'photos', 'big.py', 'notes.txt']);
  press(scr, 's');
  assert.strictEqual(scr.browser.sortKey, 'date');
  press(scr, 's');
  assert.strictEqual(scr.browser.sortKey, 'size');
  assert.deepStrictEqual(names(scr).slice(2), ['big.py', 'notes.txt'], 'largest first');
  press(scr, 's');
  press(scr, 's');
  assert.strictEqual(scr.browser.sortKey, 'name');
});

test('back and forward remember where you have been', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'docs');
  press(scr, 'return');
  assert.strictEqual(scr.browser.cwd, path.join(work, 'docs'));
  press(scr, '[');
  assert.strictEqual(scr.browser.cwd, work);
  assert.strictEqual(scr.browser.current.name, 'docs', 'back lands on the folder you left');
  press(scr, ']');
  assert.strictEqual(scr.browser.cwd, path.join(work, 'docs'));
  press(scr, '[');
  press(scr, '[');
  assert.match(scr.message, /no earlier folder/);
});

test('n makes a new folder and selects it', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  press(scr, 'n');
  assert.ok(scr.prompt, 'asks for a name');
  press(scr, 'return');
  assert.ok(fs.existsSync(path.join(work, 'untitled folder')));
  assert.strictEqual(scr.browser.current.name, 'untitled folder');
  press(scr, 'n');
  press(scr, 'return');
  assert.ok(fs.existsSync(path.join(work, 'untitled folder 2')), 'a second one gets a free name');
});

test('N makes a new file with a chosen name', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  press(scr, 'N');
  press(scr, 'u', { ctrl: true });
  type(scr, 'todo.md');
  press(scr, 'return');
  assert.ok(fs.existsSync(path.join(work, 'todo.md')));
  assert.strictEqual(scr.browser.current.name, 'todo.md');
});

test('r renames, refusing names that are taken', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'notes.txt');
  press(scr, 'r');
  assert.strictEqual(scr.prompt.value, 'notes.txt', 'starts from the current name');
  press(scr, 'u', { ctrl: true });
  type(scr, 'journal.txt');
  press(scr, 'return');
  assert.ok(fs.existsSync(path.join(work, 'journal.txt')));
  assert.strictEqual(scr.browser.current.name, 'journal.txt');

  press(scr, 'r');
  press(scr, 'u', { ctrl: true });
  type(scr, 'big.py');
  press(scr, 'return');
  assert.match(scr.message, /already exists/);
  assert.ok(fs.existsSync(path.join(work, 'journal.txt')));
});

test('d duplicates as “name copy”', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'notes.txt');
  press(scr, 'd');
  assert.ok(fs.existsSync(path.join(work, 'notes copy.txt')));
  assert.strictEqual(scr.browser.current.name, 'notes copy.txt');
});

test('c then p copies into another folder; x then p moves', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'notes.txt');
  press(scr, 'c');
  select(scr, 'docs');
  press(scr, 'return');
  press(scr, 'p');
  assert.ok(fs.existsSync(path.join(work, 'docs', 'notes.txt')));
  assert.ok(fs.existsSync(path.join(work, 'notes.txt')), 'copy leaves the original');

  press(scr, 'backspace');
  select(scr, 'big.py');
  press(scr, 'x');
  select(scr, 'photos');
  press(scr, 'return');
  press(scr, 'p');
  assert.ok(fs.existsSync(path.join(work, 'photos', 'big.py')));
  assert.ok(!fs.existsSync(path.join(work, 'big.py')), 'cut moves it');
  assert.strictEqual(scr.clipboard, null, 'a cut is used up by pasting');
});

test('t moves to the Trash and u puts it back', () => {
  const { dir, work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'notes.txt');
  press(scr, 't');
  assert.ok(!fs.existsSync(path.join(work, 'notes.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'Trash', 'notes.txt')), 'it is in the Trash, not deleted');
  assert.match(scr.message, /Trash — u to undo/);
  press(scr, 'u');
  assert.ok(fs.existsSync(path.join(work, 'notes.txt')));
  assert.match(scr.message, /undid move to Trash/);
});

test('marked items are acted on together', () => {
  const { dir, work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'big.py');
  press(scr, 'm');
  press(scr, 'm');
  assert.strictEqual(scr.browser.targets().length, 2);
  press(scr, 't');
  assert.deepStrictEqual(names(scr), ['docs', 'photos']);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'Trash')).length, 2);
  press(scr, 'z', { ctrl: true });
  assert.deepStrictEqual(names(scr), ['docs', 'photos', 'big.py', 'notes.txt']);
});

test('undo reverses a rename and a new folder', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  press(scr, 'n');
  press(scr, 'return');
  select(scr, 'notes.txt');
  press(scr, 'r');
  press(scr, 'u', { ctrl: true });
  type(scr, 'x.txt');
  press(scr, 'return');
  press(scr, 'u');
  assert.ok(fs.existsSync(path.join(work, 'notes.txt')), 'rename undone');
  press(scr, 'u');
  assert.ok(!fs.existsSync(path.join(work, 'untitled folder')), 'new folder undone (to the Trash)');
  press(scr, 'u');
  assert.match(scr.message, /nothing to undo/);
});

test('f searches subfolders and Enter reveals the result', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  press(scr, 'f');
  type(scr, 'recipe');
  press(scr, 'return');
  assert.deepStrictEqual(scr.search.results.map((p) => path.relative(work, p)), [path.join('docs', 'deep-recipe.md')]);
  scr.render();
  press(scr, 'return');
  assert.strictEqual(scr.search, null);
  assert.strictEqual(scr.browser.cwd, path.join(work, 'docs'));
  assert.strictEqual(scr.browser.current.name, 'deep-recipe.md');
});

test('i shows Get Info with a folder’s total size', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'docs');
  press(scr, 'i');
  const text = scr.info.map((l) => ansi.strip(l)).join('\n');
  assert.match(text, /Kind:\s+Folder/);
  assert.match(text, /Size:\s+7B for 1 item/);
  press(scr, 'x');
  assert.strictEqual(scr.info, null, 'any key closes it');
  assert.strictEqual(scr.clipboard, null, 'the closing key does nothing else');
});

test('the browser notices changes made elsewhere', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  fs.writeFileSync(path.join(work, 'arrived.txt'), 'new');
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(work, later, later);
  assert.strictEqual(scr.browser.changedOnDisk(), true);
  scr.browser.reload();
  assert.ok(names(scr).includes('arrived.txt'));
});

test('Tab focuses the sidebar and Escape returns', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  press(scr, 'tab');
  assert.strictEqual(scr.focus, 'sidebar');
  press(scr, 'down');
  press(scr, 'escape');
  assert.strictEqual(scr.focus, 'files');
});

test('q quits and leaves the shell in the folder; Q does not', () => {
  const { work } = finderTree();
  const a = finderScreen(work);
  press(a, 'q');
  assert.deepStrictEqual([a.done, a.cdOnExit], [true, true]);
  const b = finderScreen(work);
  press(b, 'Q');
  assert.deepStrictEqual([b.done, b.cdOnExit], [true, false]);
});

test('every rendered line is exactly the terminal width', () => {
  ansi.setEnabled(true);
  const { textWidth } = require('../src/tui');
  const { work } = finderTree();
  for (const [cols, rows] of [[60, 18], [95, 24], [140, 30]]) {
    const out = { rows, columns: cols, data: '', write(x) { this.data += x; } };
    const scr = new FilesScreen(new FileBrowser(work), { shell: {}, io: {}, output: out });
    scr.render();
    const lines = out.data.replace(/^\x1b\[H/, '').split('\r\n').map((l) => ansi.strip(l.replace(/\x1b\[K/g, '')));
    assert.strictEqual(lines.length, rows);
    lines.forEach((l, i) => assert.strictEqual(textWidth(l), cols, `${cols}x${rows} line ${i}: ${JSON.stringify(l)}`));
  }
  ansi.setEnabled(false);
});

test('fileops never deletes: undoing a copy sends it to the Trash', () => {
  const { dir, work } = finderTree();
  const rec = ops.copyInto([path.join(work, 'notes.txt')], path.join(work, 'docs'));
  ops.undo(rec);
  assert.ok(!fs.existsSync(path.join(work, 'docs', 'notes.txt')));
  assert.ok(fs.readdirSync(path.join(dir, 'Trash')).includes('notes.txt'));
});


// --- files: icon view -------------------------------------------------------------

test('icon labels wrap like Finder', () => {
  assert.deepStrictEqual(finderLabel('Downloads', 18), { lines: ['Downloads'], truncated: false });
  assert.deepStrictEqual(finderLabel('My Presentation_files', 18).lines, ['My', 'Presentation_files']);
  assert.deepStrictEqual(finderLabel('The Cluckington Family_files', 18).lines, ['The Cluckington', 'Family_files']);
  const shot = finderLabel('Screenshot 2025-05-05 at 12.35.43.png', 18);
  assert.strictEqual(shot.lines[0], 'Screenshot');
  assert.ok(shot.lines[1].endsWith('.png') && shot.lines[1].includes('…'), shot.lines[1]);
  assert.strictEqual(shot.truncated, true);
  assert.deepStrictEqual(finderLabel('snake_case_names_only_here', 12).lines[0], 'snake_case_', 'falls back to _ when there is no space');
  assert.strictEqual(middleTruncate('abcdefghij', 5), 'ab…ij');
});

test('icon art is always exactly ART_W wide, with and without colour', () => {
  const { textWidth } = require('../src/tui');
  const kinds = [
    { name: 'Downloads', isDir: true }, { name: 'plain', isDir: true }, { name: 'Safari.app', isDir: true },
    { name: 'a.py' }, { name: 'p.png' }, { name: 'm.mov' }, { name: 's.mp3' }, { name: 'z.zip' }, { name: 'x' },
  ];
  for (const on of [true, false]) {
    ansi.setEnabled(on);
    for (const e of kinds) {
      for (const row of iconArt(e)) assert.strictEqual(textWidth(ansi.strip(row)), ART_W, `${e.name} (colour ${on})`);
    }
  }
  ansi.setEnabled(false);
});

test('icon view is the default and arrows move around the grid', () => {
  const { work } = finderTree();
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(work, `f${i}.txt`), 'x');
  const scr = finderScreen(work);
  assert.strictEqual(scr.view, 'icons');
  const per = scr.layout().perRow;
  assert.ok(per >= 3, `expected several per row, got ${per}`);
  press(scr, 'right');
  assert.strictEqual(scr.browser.cursor, 1, 'right moves to the next icon, not into the folder');
  assert.strictEqual(scr.browser.cwd, work);
  press(scr, 'down');
  assert.strictEqual(scr.browser.cursor, 1 + per);
  press(scr, 'up');
  press(scr, 'left');
  assert.strictEqual(scr.browser.cursor, 0);
  press(scr, 'left');
  assert.strictEqual(scr.browser.cursor, 0, 'stops at the first icon');
  scr.browser.moveTo(99);
  press(scr, 'down');
  assert.strictEqual(scr.browser.cursor, scr.browser.visible().length - 1, 'down on the last row stays put');
});

test('Enter opens a folder and Backspace goes back up in icon view', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  select(scr, 'docs');
  press(scr, 'return');
  assert.strictEqual(scr.browser.cwd, path.join(work, 'docs'));
  press(scr, 'backspace');
  assert.strictEqual(scr.browser.cwd, work);
  assert.strictEqual(scr.browser.current.name, 'docs');
});

test('V switches between icon and column view', () => {
  const { work } = finderTree();
  const scr = finderScreen(work);
  press(scr, 'V');
  assert.strictEqual(scr.view, 'columns');
  select(scr, 'docs');
  press(scr, 'right');
  assert.strictEqual(scr.browser.cwd, path.join(work, 'docs'), 'in columns, right opens the folder');
  press(scr, 'V');
  assert.strictEqual(scr.view, 'icons');
});

test('the icon grid fills the terminal exactly and shows a tooltip for long names', () => {
  ansi.setEnabled(true);
  const { textWidth } = require('../src/tui');
  const { work } = finderTree();
  fs.writeFileSync(path.join(work, 'Screenshot 2025-05-05 at 12.35.43 with a much longer name.png'), '');
  for (const [cols, rows] of [[64, 20], [100, 30], [150, 40]]) {
    const out = { rows, columns: cols, data: '', write(x) { this.data += x; } };
    const scr = new FilesScreen(new FileBrowser(work), { shell: {}, io: {}, output: out });
    scr.browser.moveTo(scr.browser.visible().findIndex((e) => e.name.startsWith('Screenshot')));
    scr.render();
    const frame = out.data.split(/\x1b\[\d+;\d+H/)[0];
    const lines = frame.replace(/^\x1b\[H/, '').split('\r\n').map((l) => ansi.strip(l.replace(/\x1b\[K/g, '')));
    assert.strictEqual(lines.length, rows);
    lines.forEach((l, i) => assert.strictEqual(textWidth(l), cols, `${cols}x${rows} line ${i}`));
    assert.ok(scr.tooltip && scr.tooltip.text.startsWith('Screenshot'), 'the full name is shown as a tooltip');
    assert.match(ansi.strip(out.data), /Screenshot 2025-05-05 at 12\.35\.43 with a/);
  }
  ansi.setEnabled(false);
});

test('the selected icon keeps the grid in view when it scrolls', () => {
  const { work } = finderTree();
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(work, `item${String(i).padStart(2, '0')}.txt`), '');
  const out = { rows: 20, columns: 90, data: '', write(x) { this.data += x; } };
  const scr = new FilesScreen(new FileBrowser(work), { shell: {}, io: {}, output: out });
  scr.browser.reload();
  scr.browser.moveTo(scr.browser.visible().length - 1);
  scr.render();
  const L = scr.layout();
  const row = Math.floor(scr.browser.cursor / L.perRow);
  assert.ok(row >= scr.gridTop && row < scr.gridTop + L.rowsVisible, 'last item is on screen');
  assert.match(ansi.strip(out.data), /item59\.txt/);
});


// --- files: the mouse ------------------------------------------------------------

// Screen position of icon `i` in the grid (1-based, like the terminal reports).
function iconAt(scr, i) {
  const L = scr.layout();
  const left = (L.sideW ? L.sideW + 1 : 0) + 1;
  const row = Math.floor(i / L.perRow) - scr.gridTop;
  return { x: left + (i % L.perRow) * L.cellW + 3, y: 2 + row * CELL_H + 1 };
}
const click = (scr, x, y, button = 0) => scr.handleKey({ name: 'mouse', button, x, y, release: false });

function mouseScreen(work) {
  const scr = finderScreen(work);
  scr.render();
  scr.opened = [];
  scr.openWithApp = (e) => scr.opened.push(['app', e.name]);
  scr.openInside = (e, how) => scr.opened.push([how, e.name]);
  return scr;
}

test('a click selects an icon without opening it', () => {
  const { work } = finderTree();
  const scr = mouseScreen(work);
  const i = scr.browser.visible().findIndex((e) => e.name === 'notes.txt');
  const { x, y } = iconAt(scr, i);
  click(scr, x, y);
  assert.strictEqual(scr.browser.current.name, 'notes.txt');
  assert.deepStrictEqual(scr.opened, []);
});

test('double-clicking a folder opens it', () => {
  const { work } = finderTree();
  const scr = mouseScreen(work);
  const { x, y } = iconAt(scr, scr.browser.visible().findIndex((e) => e.name === 'docs'));
  click(scr, x, y);
  click(scr, x, y);
  assert.strictEqual(scr.browser.cwd, path.join(work, 'docs'));
});

test('double-clicking a file opens it — code in the editor, other files in their app', () => {
  const { work } = finderTree();
  fs.writeFileSync(path.join(work, 'photo.png'), Buffer.from([0x89, 0x50, 0, 0]));
  const scr = mouseScreen(work);
  scr.browser.reload();
  for (const name of ['big.py', 'photo.png']) {
    scr.render();
    const { x, y } = iconAt(scr, scr.browser.visible().findIndex((e) => e.name === name));
    click(scr, x, y);
    click(scr, x, y);
  }
  assert.deepStrictEqual(scr.opened, [['edit', 'big.py'], ['app', 'photo.png']]);
});

test('two slow clicks are two single clicks', () => {
  const { work } = finderTree();
  const scr = mouseScreen(work);
  const { x, y } = iconAt(scr, scr.browser.visible().findIndex((e) => e.name === 'docs'));
  click(scr, x, y);
  scr.lastClick.t -= 2000;
  click(scr, x, y);
  assert.strictEqual(scr.browser.cwd, work, 'did not open');
});

test('clicks on different icons are not a double click', () => {
  const { work } = finderTree();
  const scr = mouseScreen(work);
  const a = iconAt(scr, 0);
  const b = iconAt(scr, 1);
  click(scr, a.x, a.y);
  click(scr, b.x, b.y);
  assert.strictEqual(scr.browser.cwd, work);
  assert.strictEqual(scr.browser.cursor, 1);
});

test('clicking empty space or a label row still hits the right icon', () => {
  const { work } = finderTree();
  const scr = mouseScreen(work);
  const { x, y } = iconAt(scr, 2);
  click(scr, x, y + 5);
  assert.strictEqual(scr.browser.cursor, 2, 'the name under an icon belongs to it');
  const before = scr.browser.cursor;
  click(scr, x, scr.layout().bodyH);
  assert.strictEqual(scr.browser.cursor, before, 'blank area changes nothing');
});

test('the scroll wheel moves through the grid', () => {
  const { work } = finderTree();
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(work, `w${i}.txt`), '');
  const scr = mouseScreen(work);
  scr.browser.reload();
  const per = scr.layout().perRow;
  click(scr, 30, 5, 65);
  assert.strictEqual(scr.browser.cursor, per);
  click(scr, 30, 5, 64);
  assert.strictEqual(scr.browser.cursor, 0);
});

test('clicking the sidebar and the path bar navigates', () => {
  const { work } = finderTree();
  const scr = mouseScreen(work);
  const i = scr.sidebar.findIndex((it) => it.path);
  click(scr, 5, 2 + i);
  assert.strictEqual(scr.browser.cwd, scr.sidebar[i].path);

  const docs = path.join(work, 'docs');
  scr.browser.goTo(docs);
  scr.render();
  const seg = scr.pathSegs.find((p) => p.path === work);
  assert.ok(seg, 'the path bar has a segment for the parent folder');
  click(scr, seg.from, scr.layout().bodyH + 2);
  assert.strictEqual(scr.browser.cwd, work);
  assert.strictEqual(scr.browser.current.name, 'docs', 'lands on the folder you came from');
});

test('in column view clicks select, double clicks open, and the parent column navigates', () => {
  const { work } = finderTree();
  const out = { rows: 24, columns: 140, data: '', write(x) { this.data += x; } };
  const scr = new FilesScreen(new FileBrowser(path.join(work, 'docs')), { shell: {}, io: {}, output: out });
  scr.view = 'columns';
  scr.render();
  const L = scr.layout();
  assert.ok(L.parentW > 0, 'wide enough for a parent column');
  const parentX = L.sideW + 2 + 2;
  const parentList = scr.parentEntries();
  const photos = parentList.findIndex((e) => e.name === 'photos');
  click(scr, parentX, 2 + photos - scr.parentTop);
  assert.strictEqual(scr.browser.cwd, path.join(work, 'photos'), 'a folder in the parent column opens');

  scr.browser.goTo(work);
  scr.render();
  const currentX = L.sideW + 1 + L.parentW + 1 + 3;
  const idx = scr.browser.visible().findIndex((e) => e.name === 'docs');
  click(scr, currentX, 2 + idx - scr.browser.top);
  assert.strictEqual(scr.browser.current.name, 'docs');
  assert.strictEqual(scr.browser.cwd, work, 'one click only selects');
  click(scr, currentX, 2 + idx - scr.browser.top);
  assert.strictEqual(scr.browser.cwd, path.join(work, 'docs'));
});

test('the mouse is ignored while a prompt or help is open', () => {
  const { work } = finderTree();
  const scr = mouseScreen(work);
  press(scr, 'n');
  const { x, y } = iconAt(scr, 1);
  click(scr, x, y);
  assert.ok(scr.prompt, 'the prompt is still open');
  assert.strictEqual(scr.browser.cursor, 0);
});

test('mouse reports decode, and releases are ignored', () => {
  const { KeyReader } = require('../src/keys');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxmouse-')), 'm');
  fs.writeFileSync(file, '\x1b[<0;12;7M\x1b[<0;12;7m\x1b[<65;1;1M\x1b[<32;4;4Mx');
  const r = new KeyReader(fs.openSync(file, 'r'));
  const keys = [r.next(), r.next(), r.next(), r.next(), r.next()];
  assert.deepStrictEqual(keys.slice(0, 4).map((k) => [k.name, k.button, k.x, k.y, k.release, k.drag]), [
    ['mouse', 0, 12, 7, false, false], ['mouse', 0, 12, 7, true, false],
    ['mouse', 65, 1, 1, false, false], ['mouse', 0, 4, 4, false, true],
  ]);
  assert.strictEqual(keys[4].str, 'x', 'ordinary keys still follow');
});

if (failures) {
  console.error(`\n${failures} tools test(s) failed`);
  process.exit(1);
}
console.log('\nall tools tests passed');
