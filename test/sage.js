'use strict';

// Sage: the full-screen app (state, drawing, clicks), Sage Code's tools, the
// engine plumbing (against test/fake-sage-engine.js, no model), and
// sage.py's tool-call parsing.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ansi = require('../src/ansi');
const tools = require('../src/sagetools');
const { SageApp, Engine, render } = require('../src/sage');
const { sleepSync } = require('../src/keys');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok - ${name}\n  ${e.stack}`);
  }
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-test-'));
  process.env.MAXSHELL_TRASH = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-trash-'));
  fs.writeFileSync(path.join(root, 'a.py'), 'def f():\n    return 1\n\nprint(f())\n');
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'b.js'), 'const x = 1;\n');
  return root;
}

// An engine stand-in that records what's sent.
function fakeEngine() {
  const e = { sent: [], closed: false, interrupted: 0 };
  e.send = (c) => e.sent.push(c);
  e.poll = () => [];
  e.close = () => { e.closed = true; };
  e.interrupt = () => { e.interrupted++; };
  e.errors = () => '';
  return e;
}

function app(opts = {}) {
  const started = [];
  const a = new SageApp({
    mode: 'chat', root: os.tmpdir(), model: 'e4b',
    models: [{ key: 'ultra', ready: true }, { key: 'e4b', ready: true }, { key: 'e2b', ready: true }],
    start: (key, mode) => { const e = fakeEngine(); started.push({ key, mode, e }); return e; },
    ...opts,
  });
  a.started = started;
  return a;
}

const fits = (r, cols) => r.lines.forEach((l) => assert.ok(ansi.width(l) <= cols, `${ansi.width(l)} > ${cols}: ${ansi.strip(l)}`));
const text = (r) => r.lines.map((l) => ansi.strip(l)).join('\n');

test('sage code tools look around the project', () => {
  const root = project();
  assert.deepStrictEqual(tools.look('list_files', {}, root).text.split('\n'), ['lib/', 'a.py']);
  assert.match(tools.look('read_file', { path: 'a.py' }, root).text, /return 1/);
  assert.strictEqual(tools.look('read_file', { path: 'a.py' }, root).detail, '4 lines');
  assert.match(tools.look('read_file', { path: 'nope.py' }, root).text, /Can't read/);
  assert.strictEqual(tools.look('search_files', { text: 'const' }, root).text, 'lib/b.js:1: const x = 1;');
  assert.strictEqual(tools.needsAsk('read_file', { path: 'a.py' }, root), false);
  assert.strictEqual(tools.needsAsk('read_file', { path: '/etc/hosts' }, root), true);
  assert.strictEqual(tools.needsAsk('edit_file', { path: 'a.py' }, root), true);
  fs.rmSync(root, { recursive: true });
});

test('sage code edits need one exact match, and old versions go to the Trash', () => {
  const root = project();
  assert.match(tools.plan('edit_file', { path: 'a.py', old_text: 'return 9', new_text: 'x' }, root).error, /isn't in a\.py/);
  fs.appendFileSync(path.join(root, 'a.py'), 'print(f())\n');
  assert.match(tools.plan('edit_file', { path: 'a.py', old_text: 'print(f())', new_text: 'x' }, root).error, /more than once/);
  assert.match(tools.plan('edit_file', { path: 'new.py', old_text: 'a', new_text: 'b' }, root).error, /write_file/);
  assert.match(tools.plan('write_file', { path: 'lib', content: 'x' }, root).error, /folder/);
  const p = tools.plan('edit_file', { path: 'a.py', old_text: 'return 1', new_text: 'return 2' }, root);
  const d = tools.diff(p.before, p.after);
  assert.deepStrictEqual(d.rows.filter((r) => r.kind !== ' ').map((r) => `${r.kind}${r.text}`), ['-    return 1', '+    return 2']);
  assert.strictEqual(d.added, 1);
  assert.match(tools.apply(p).text, /old version is in the Trash/);
  assert.match(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), /return 2/);
  assert.match(fs.readFileSync(path.join(process.env.MAXSHELL_TRASH, 'a.py'), 'utf8'), /return 1/);
  const w = tools.plan('write_file', { path: 'src/new.txt', content: 'hi' }, root);
  assert.strictEqual(w.after, 'hi\n');
  assert.match(tools.apply(w).text, /Created src\/new\.txt \(1 line\)/);
  fs.rmSync(root, { recursive: true });
});

test('diffs keep three lines of context around changes', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = before.replace('line 10\n', 'line ten\n');
  const rows = tools.diff(before, after).rows;
  assert.deepStrictEqual(rows.map((r) => r.kind).join(''), '   -+   ');
  assert.strictEqual(rows[0].a, 7);
  const two = tools.diff(before, after.replace('line 2\n', 'line two\n')).rows.map((r) => r.kind).join('');
  assert.ok(two.includes('…'), two);
});

test('the sage screen fits every terminal size, empty or busy', () => {
  for (const mode of ['chat', 'code']) {
    const a = app({ mode, root: project() });
    for (const [c, r] of [[100, 30], [60, 20], [34, 12], [20, 8]]) fits(render(a, c, r, 0), c);
    a.onEvent({ ev: 'ready' });
    a.setInput('x'.repeat(300));
    a.submit();
    a.onEvent({ ev: 'text', s: '# Title\n\nSome **bold** text with $x^2$ and a long line '.repeat(5) + '\n\n```py\nprint("hi")\n```\n' });
    for (const [c, r] of [[100, 30], [60, 20], [34, 12], [20, 8]]) fits(render(a, c, r, 0), c);
    a.openMenu();
    for (const [c, r] of [[100, 30], [40, 12], [20, 8]]) fits(render(a, c, r, 0), c);
  }
});

test('sage shows a welcome with clickable examples until the first message', () => {
  const a = app();
  const r = render(a, 90, 26, 0);
  assert.match(text(r), /S {2}A {2}G {2}E/);
  assert.match(text(r), /private|Private/);
  const ex = r.hits.find((h) => h.action === 'try');
  a.mouse({ button: 0, release: false }, ex);
  assert.strictEqual(a.input, ex.text);
  assert.match(text(render(app({ mode: 'code' }), 90, 26, 0)), /asked first/);
});

test('messages wait for the model, then go to it; answers stream in', () => {
  const a = app();
  const e = a.started[0].e;
  a.setInput('hello?');
  a.submit();
  assert.strictEqual(e.sent.length, 0);
  a.onEvent({ ev: 'ready' });
  assert.deepStrictEqual(e.sent, [{ op: 'ask', text: 'hello?' }]);
  assert.strictEqual(a.status, 'thinking');
  a.onEvent({ ev: 'text', s: 'Hi ' });
  a.onEvent({ ev: 'text', s: 'there' });
  assert.strictEqual(a.status, 'writing');
  a.onEvent({ ev: 'done', tokens: 20, seconds: 2 });
  assert.strictEqual(a.status, 'ready');
  const shown = text(render(a, 80, 20, 0));
  assert.match(shown, /10\.0 tok\/s[\s\S]*❯ hello\?\n\s*\n\s*✦ Hi there/);
  assert.strictEqual(shown.match(/hello\?/g).length, 1);
});

test('the model dropdown opens by click or ^O and switches models', () => {
  const a = app();
  a.onEvent({ ev: 'ready' });
  let r = render(a, 90, 24, 0);
  const drop = r.hits.find((h) => h.action === 'menu');
  assert.strictEqual(drop.y, 0);
  assert.match(text(r).split('\n')[0], /Sage Pro ▾/);
  a.mouse({ button: 0, release: false }, drop);
  r = render(a, 90, 24, 0);
  assert.match(text(r), /Sage Ultra[\s\S]*best at code[\s\S]*✓ Sage Pro[\s\S]*Sage Lite/);
  const e2b = r.hits.find((h) => h.action === 'model' && h.key === 'e2b');
  a.mouse({ button: 0, release: false }, e2b);
  assert.strictEqual(a.model, 'e2b');
  assert.strictEqual(a.started.length, 2);
  assert.strictEqual(a.started[0].e.closed, true);
  assert.strictEqual(a.status, 'loading');
  assert.match(text(render(a, 90, 24, 0)).split('\n')[0], /Sage Lite ▾/);
  // keys: ^O, down, enter
  a.key({ name: 'o', ctrl: true });
  a.key({ name: 'up' });
  a.key({ name: 'return' });
  assert.strictEqual(a.model, 'e4b');
  a.key({ name: 'o', ctrl: true });
  a.key({ name: 'up' });
  a.key({ name: 'return' });
  assert.strictEqual(a.model, 'ultra');
  assert.match(text(render(a, 90, 24, 0)).split('\n')[0], /Sage Ultra ▾/);
  // a model that isn't set up says how to set it up
  const b = app({ models: [{ key: 'ultra', ready: false }, { key: 'e4b', ready: true }, { key: 'e2b', ready: false }] });
  b.switchModel('e2b');
  assert.strictEqual(b.model, 'e4b');
  assert.match(b.items[b.items.length - 1].text, /sage --lite --setup/);
  b.switchModel('ultra');
  assert.match(b.items[b.items.length - 1].text, /Sage Ultra isn’t set up — run: sage --ultra --setup/);
});

test('sage code asks before a change; y applies it, n tells Sage no', () => {
  const root = project();
  const a = app({ mode: 'code', root });
  const e = a.started[0].e;
  a.onEvent({ ev: 'ready' });
  a.onEvent({ ev: 'tool', name: 'read_file', args: { path: 'a.py' } });
  assert.match(e.sent.pop().text, /return 1/); // reads in the project don't ask
  a.onEvent({ ev: 'tool', name: 'edit_file', args: { path: 'a.py', old_text: 'return 1', new_text: 'return 2' } });
  assert.strictEqual(a.status, 'waiting');
  assert.strictEqual(e.sent.length, 0);
  const r = render(a, 90, 30, 0);
  assert.match(text(r), /Edit a\.py · \+1 −1[\s\S]*- {5}return 1[\s\S]*\+ {5}return 2[\s\S]*Make this change\?/);
  const yes = r.hits.find((h) => h.action === 'answer' && h.choice === 'y');
  a.mouse({ button: 0, release: false }, yes);
  assert.match(e.sent.pop().text, /Saved a\.py/);
  assert.match(fs.readFileSync(path.join(root, 'a.py'), 'utf8'), /return 2/);
  a.onEvent({ ev: 'tool', name: 'write_file', args: { path: 'b.txt', content: 'x' } });
  a.key({ name: 'n', str: 'n', printable: true });
  assert.match(e.sent.pop().text, /said no/);
  assert.strictEqual(fs.existsSync(path.join(root, 'b.txt')), false);
  // "a": yes now and from then on
  a.onEvent({ ev: 'tool', name: 'write_file', args: { path: 'b.txt', content: 'x' } });
  a.key({ name: 'a', str: 'a', printable: true });
  a.onEvent({ ev: 'tool', name: 'write_file', args: { path: 'c.txt', content: 'y' } });
  assert.strictEqual(a.approval, null);
  assert.ok(fs.existsSync(path.join(root, 'c.txt')));
  // a bad edit is reported straight back to Sage
  a.onEvent({ ev: 'tool', name: 'edit_file', args: { path: 'a.py', old_text: 'nope', new_text: 'x' } });
  assert.match(e.sent.pop().text, /isn't in a\.py/);
  fs.rmSync(root, { recursive: true });
});

test('sage code runs commands after a yes, and always asks for risky ones', () => {
  const root = project();
  const a = app({ mode: 'code', root });
  const e = a.started[0].e;
  a.onEvent({ ev: 'ready' });
  a.onEvent({ ev: 'tool', name: 'run_command', args: { command: 'mkdir -p src/utils && echo made' } });
  assert.strictEqual(a.status, 'waiting');
  let r = render(a, 90, 30, 0);
  assert.match(text(r), /● Run[\s\S]*\$ mkdir -p src\/utils && echo made[\s\S]*Run it\?/);
  a.key({ name: 'y', str: 'y', printable: true });
  assert.strictEqual(a.status, 'running');
  assert.match(text(render(a, 90, 30, 0)), /running…/);
  a.work();
  assert.ok(fs.statSync(path.join(root, 'src', 'utils')).isDirectory());
  assert.strictEqual(e.sent.pop().text, 'exit 0\nmade');
  assert.match(text(render(a, 90, 30, 0)), /exit 0[\s\S]*made/);
  a.onEvent({ ev: 'text', s: '\n' });
  assert.ok(!/✦\s*\n/.test(text(render(a, 90, 30, 0))), 'no empty ✦ line');
  // "a": no more asking for commands…
  a.onEvent({ ev: 'tool', name: 'run_command', args: { command: 'false' } });
  a.key({ name: 'a', str: 'a', printable: true });
  a.work();
  assert.match(e.sent.pop().text, /^exit 1/);
  a.onEvent({ ev: 'tool', name: 'run_command', args: { command: 'echo two' } });
  assert.strictEqual(a.approval, null);
  a.work();
  assert.match(e.sent.pop().text, /two/);
  // …but a risky one is always asked, and offers no "don't ask again"
  a.onEvent({ ev: 'tool', name: 'run_command', args: { command: 'rm -rf src' } });
  assert.ok(a.approval);
  r = render(a, 90, 30, 0);
  assert.match(text(r), /careful/);
  assert.ok(!r.hits.some((h) => h.action === 'answer' && h.choice === 'a'));
  a.key({ name: 'n', str: 'n', printable: true });
  assert.match(e.sent.pop().text, /said no/);
  assert.ok(fs.existsSync(path.join(root, 'src')));
  fs.rmSync(root, { recursive: true });
});

test('risky commands are told apart from everyday ones', () => {
  for (const c of ['rm -rf build', 'sudo make install', 'git reset --hard', 'ls > files.txt', 'find . -delete', 'cd x && rm a']) assert.ok(tools.risky(c), c);
  for (const c of ['mkdir -p src/utils', 'npm test', 'git status', 'python3 a.py >> log', 'echo hi 2>/dev/null', 'ls | grep a']) assert.ok(!tools.risky(c), c);
});

test('plain sage has no tools', () => {
  const a = app();
  a.onEvent({ ev: 'ready' });
  a.onEvent({ ev: 'tool', name: 'write_file', args: { path: 'x', content: 'y' } });
  assert.match(a.started[0].e.sent.pop().text, /no tools in chat/);
});

test('^C stops an answer, then clears the input, then leaves', () => {
  const a = app();
  const e = a.started[0].e;
  a.onEvent({ ev: 'ready' });
  a.send('long story');
  a.key({ name: 'c', ctrl: true });
  assert.strictEqual(e.interrupted, 1);
  assert.strictEqual(a.status, 'stopping');
  a.onEvent({ ev: 'done', stopped: true });
  a.setInput('draft');
  a.key({ name: 'c', ctrl: true });
  assert.strictEqual(a.input, '');
  assert.strictEqual(a.done, false);
  a.key({ name: 'c', ctrl: true });
  assert.strictEqual(a.done, true);
});

test('slash commands: /new, /model, /help, /exit', () => {
  const a = app();
  const e = a.started[0].e;
  a.onEvent({ ev: 'ready' });
  a.send('hi');
  a.onEvent({ ev: 'done' });
  a.setInput('/new');
  a.submit();
  assert.strictEqual(a.items.length, 0);
  assert.deepStrictEqual(e.sent.pop(), { op: 'reset' });
  a.onEvent({ ev: 'ready' });
  a.setInput('/model e2b');
  a.submit();
  assert.strictEqual(a.model, 'e2b');
  a.setInput('/help');
  a.submit();
  assert.match(a.items[a.items.length - 1].text, /\/model/);
  a.setInput('/exit');
  a.submit();
  assert.strictEqual(a.done, true);
});

test('the engine plumbing streams events from a separate process', () => {
  const root = project();
  const e = new Engine([process.execPath, path.join(__dirname, 'fake-sage-engine.js'), '{commands}', 'code'], { cwd: root, env: process.env });
  const events = [];
  const wait = (ev) => {
    for (let i = 0; i < 250; i++) {
      const got = e.poll();
      events.push(...got);
      if (got.some((g) => g.ev === ev)) return got.find((g) => g.ev === ev);
      sleepSync(20);
    }
    throw new Error(`no ${ev} event; stderr: ${e.errors()}`);
  };
  wait('ready');
  e.send({ op: 'ask', text: 'say hi' });
  wait('done');
  assert.strictEqual(events.filter((x) => x.ev === 'text').map((x) => x.s).join(''), 'You said: say hi');
  e.send({ op: 'ask', text: 'edit it' });
  const call = wait('tool');
  assert.strictEqual(call.name, 'edit_file');
  e.send({ op: 'result', text: 'Saved.' });
  wait('done');
  assert.match(events.map((x) => x.s || '').join(''), /Result: Saved\./);
  e.close();
  assert.strictEqual(fs.existsSync(e.dir), false);
  fs.rmSync(root, { recursive: true });
});

test('sage.py parses Gemma tool calls and hides them from the reply', () => {
  const script = String.raw`
import sys, json
sys.path.insert(0, sys.argv[1])
import sage as gemma
raw = 'Sure!<|tool_call>call:edit_file{new_text:<|"|>x = {1: 2}<|"|>,old_text:<|"|>x = 1<|"|>,path:<|"|>a.py<|"|>}<tool_call|>'
print(json.dumps({'call': gemma.parse_call(raw),
  'seen': gemma.visible(raw + gemma.tool_response('edit_file', 'ok') + 'Done.<turn|>'),
  'partial': gemma.visible('Sure!<|tool_call>call:edit_fi'),
  'tools': [t['function']['name'] for t in gemma.CODE_TOOLS],
  'ucalls': gemma.ultra_parse_calls('Sure.\n<tool_call>\n{"name": "run_command", "arguments": {"command": "mkdir -p x"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.py"}}\n</tool_call><tool_call>{bad json}</tool_call>'),
  'useen': gemma.ultra_visible('Sure.<tool_call>\n{"name": "x", "arguments": {}}\n</tool_call><|im_end|>'),
  'upartial': gemma.ultra_visible('Sure.<tool_call>\n{"na'),
  'uresp': gemma.ultra_tool_responses(['exit 0', 'text']),
  'fenced': gemma.ultra_scan('Sure.\n\x60\x60\x60json\n{"name": "run_command", "arguments": {"command": "mkdir -p lib"}}\n\x60\x60\x60\nI made it.'),
  'pycode': gemma.ultra_scan('py:\n\x60\x60\x60python\nprint({"name": 1})\n\x60\x60\x60\nok'),
  'holding': gemma.ultra_scan('x\n\x60\x60\x60jso')[0],
  'chat': 'sage code' in gemma.system_prompt('chat') and 'introduce yourself as Sage' in gemma.system_prompt('chat'), 'code': 'edit_file' in gemma.system_prompt('code') and 'mkdir -p' in gemma.system_prompt('code')}))
`;
  const r = spawnSync('python3', ['-I', '-c', script, path.join(__dirname, '..', 'src')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(out.call, ['edit_file', { new_text: 'x = {1: 2}', old_text: 'x = 1', path: 'a.py' }]);
  assert.strictEqual(out.seen, 'Sure!Done.');
  assert.strictEqual(out.partial, 'Sure!');
  assert.deepStrictEqual(out.tools, ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command']);
  assert.deepStrictEqual([out.chat, out.code], [true, true]);
  // Sage Ultra (Qwen) writes its calls as JSON in <tool_call> tags
  assert.deepStrictEqual(out.ucalls, [['run_command', { command: 'mkdir -p x' }], ['read_file', { path: 'a.py' }]]);
  assert.strictEqual(out.useen, 'Sure.');
  assert.strictEqual(out.upartial, 'Sure.');
  // …or as a ```json block: taken out, and the answer cut where the call ends
  assert.deepStrictEqual(out.fenced[1], [['run_command', { command: 'mkdir -p lib' }]]);
  assert.strictEqual(out.fenced[2], 'Sure.\n```json\n{"name": "run_command", "arguments": {"command": "mkdir -p lib"}}\n```\n'.length);
  assert.deepStrictEqual(out.pycode, ['py:\n```python\nprint({"name": 1})\n```\nok', [], null]);
  assert.strictEqual(out.holding, 'x\n');
  assert.strictEqual(out.uresp, '<|im_start|>user\n<tool_response>\nexit 0\n</tool_response>\n<tool_response>\ntext\n</tool_response><|im_end|>\n<|im_start|>assistant\n');
});

test('sage --help names chat and code; sage code needs a terminal', () => {
  const sh = path.join(__dirname, '..', 'bin', 'maxshell.js');
  const env = { ...process.env, MAXSHELL_SETUP: '0' };
  const help = spawnSync('node', [sh, '-c', 'sage --help'], { env, encoding: 'utf8' });
  assert.match(help.stdout, /sage code/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-'));
  const code = spawnSync('node', [sh, '-c', 'sage code'], { env: { ...env, MAXSHELL_GEMMA: dir, MAXSHELL_GEMMA_PYTHON: process.execPath }, encoding: 'utf8' });
  assert.strictEqual(code.status, 1);
  fs.rmSync(dir, { recursive: true });
});

test('without room for E4B, Sage picks E2B unless a model was asked for', () => {
  const gemma = require('../src/gemma');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-models-'));
  const was = { ...process.env };
  try {
    process.env.MAXSHELL_GEMMA = dir;
    process.env.MAXSHELL_GEMMA_PYTHON = process.execPath;
    for (const f of [...gemma.FILES, 'model.safetensors']) fs.writeFileSync(path.join(dir, f), '');
    process.env.MAXSHELL_SAGE_FREE = '30';
    const auto = gemma.fallback('e4b', false);
    assert.strictEqual(auto.key, 'e2b');
    assert.match(auto.why, /30% of memory is free and Sage Pro needs 40%/);
    assert.strictEqual(gemma.fallback('e4b', true).key, 'e4b');
    process.env.MAXSHELL_SAGE_FREE = '55';
    assert.strictEqual(gemma.fallback('e4b', false).key, 'e4b');
    fs.rmSync(path.join(dir, 'model.safetensors'));
    process.env.MAXSHELL_SAGE_FREE = '30';
    assert.strictEqual(gemma.fallback('e4b', false).key, 'e4b'); // E2B isn't set up
    delete process.env.MAXSHELL_SAGE_MODEL;
    assert.strictEqual(gemma.pick(['hi']).chosen, false);
    assert.strictEqual(gemma.pick(['--e4b', 'hi']).chosen, true);
    const a = app({ notice: auto.why });
    assert.match(text(render(a, 90, 26, 0)).replace(/\s+/g, ' '), /this is Sage Lite, the lighter model/);
    assert.strictEqual(gemma.pick(['--lite', 'hi']).key, 'e2b');
    assert.strictEqual(gemma.pick(['--ultra', 'hi']).key, 'ultra');
    assert.strictEqual(gemma.MODELS.ultra.label, 'Sage Ultra');
    assert.ok(!/Gemma/.test(text(render(app(), 90, 26, 0))));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in was)) delete process.env[k];
    Object.assign(process.env, was);
    fs.rmSync(dir, { recursive: true });
  }
});

if (failures) {
  console.error(`\n${failures} sage test(s) failed`);
  process.exit(1);
}
console.log('\nall sage tests passed');
