'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ansi = require('../src/ansi');
const syntax = require('../src/syntax');
const { EditorBuffer, PyEditor } = require('../src/pyedit');
const { Pager, PagerScreen } = require('../src/view');
const { FileBrowser, previewOf } = require('../src/files');
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

if (failures) {
  console.error(`\n${failures} tools test(s) failed`);
  process.exit(1);
}
console.log('\nall tools tests passed');
