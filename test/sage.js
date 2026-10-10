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

// Never open Preview or QuickTime Player from a test (children inherit it).
process.env.MAXSHELL_IMAGE_NO_OPEN = '1';
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

// A 2×2 RGB PNG: red, green / blue, white.
function makePng() {
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(2, 0);
  head.writeUInt32BE(2, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
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
    models: [{ key: 'ultra', ready: true }, { key: 'e4b', ready: true }, { key: 'e2b', ready: true }, { key: 'lite', ready: true }],
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

test('thinking shows as it comes, muted, then says how long it took', () => {
  const a = app();
  a.onEvent({ ev: 'ready' });
  a.setInput('what is 23 * 47?');
  a.submit();
  a.onEvent({ ev: 'think', s: 'They want 23 × 47. ' });
  a.onEvent({ ev: 'think', s: '20 × 47 = 940, plus 3 × 47 = 141, so 1081. '.repeat(3) });
  let shown = text(render(a, 50, 24, 0));
  assert.match(shown, /◇ Thinking…\n\s*│ They want 23 × 47\./);
  assert.doesNotMatch(shown, /thinking…/); // the thinking itself replaces the spinner
  for (const l of shown.split('\n')) assert.ok(require('../src/tui').textWidth(l) <= 50, l);
  a.onEvent({ ev: 'text', s: '23 × 47 = **1081**' });
  a.onEvent({ ev: 'done', tokens: 20, seconds: 2 });
  shown = text(render(a, 50, 30, 0));
  assert.match(shown, /◇ Thought for \d+s\n\s*│ They want[\s\S]*✦ 23 × 47 = 1081/);
  // after a tool call the model thinks again: a new block
  a.onEvent({ ev: 'think', s: 'Next step.' });
  assert.strictEqual(a.items.filter((i) => i.type === 'thought').length, 2);
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
  assert.match(text(r), /Sage Ultra[\s\S]*smartest[\s\S]*✓ Sage Pro[\s\S]*Sage Flash[\s\S]*Sage Lite[\s\S]*fastest/);
  const e2b = r.hits.find((h) => h.action === 'model' && h.key === 'e2b');
  a.mouse({ button: 0, release: false }, e2b);
  assert.strictEqual(a.model, 'e2b');
  assert.strictEqual(a.started.length, 2);
  assert.strictEqual(a.started[0].e.closed, true);
  assert.strictEqual(a.status, 'loading');
  assert.match(text(render(a, 90, 24, 0)).split('\n')[0], /Sage Flash ▾/);
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
  assert.match(b.items[b.items.length - 1].text, /sage --flash --setup/);
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
  'gscan': gemma.GemmaChat.scan('Hi <|channel>thought\nthey want a greeting<channel|>there<turn|>'),
  'gturn': gemma.GemmaChat.user_turn(None, 'hey'),
  'qscan': gemma.QwenLiteChat.scan('<think>\n\n</think>\n\nHi there.<|im_end|>'),
  'qturn': gemma.QwenLiteChat.user_turn(gemma.QwenLiteChat.__new__(gemma.QwenLiteChat), 'hey'),
  'mcall': gemma.MistralChat.scan('Let me look.[TOOL_CALLS]read_file[ARGS]{"path": "a.py"}</s>'),
  'mwait': gemma.MistralChat.scan('Let me look.[TOOL_CALLS]read_file[ARGS]{"pa'),
  'mplain': gemma.MistralChat.scan('Done.</s>'),
  'uthink': gemma.QwenUltraChat.scan('they want a sum, 2 + 2'),
  'uanswer': gemma.QwenUltraChat.scan('2 + 2\n</think>\n\nIt is 4.<|im_end|>'),
  'ucall': gemma.QwenUltraChat.scan('plan\n</think>\n\nLet me look.\n<tool_call>\n<function=write_file>\n<parameter=path>\na.py\n</parameter>\n<parameter=content>\nx = 1\n\n</parameter>\n</function>\n</tool_call><|im_end|>'),
  'uwait': gemma.QwenUltraChat.scan('plan</think>Let me look.<tool_call>\n<function=read_fi'),
  'uthought': [gemma.QwenUltraChat.thought('\nThey want a sum.</thi'), gemma.QwenUltraChat.thought('\nThey want a sum.\n</think>\n\nIt is 4.')],
  'gthought': gemma.GemmaChat.thought('<|channel>thought\nplan it<channel|>Hi<|channel>more<chan'),
  'uturn': gemma.QwenUltraChat.user_turn(gemma.QwenUltraChat.__new__(gemma.QwenUltraChat), 'hey'),
  'gcall': gemma.GemmaChat.scan('Let me look.<|tool_call>call:read_file{path:<|"|>a.py<|"|>}<tool_call|><|tool_response>'),
  'ganswer': gemma.GemmaChat.answer(None, [('read_file', {})], ['x = 1']),
  'thinking': gemma.visible('<|channel>thought\nplan\n'),
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
  // Qwen writes its calls as JSON in <tool_call> tags
  assert.deepStrictEqual(out.ucalls, [['run_command', { command: 'mkdir -p x' }], ['read_file', { path: 'a.py' }]]);
  assert.strictEqual(out.useen, 'Sure.');
  assert.strictEqual(out.upartial, 'Sure.');
  // …or as a ```json block: taken out, and the answer cut where the call ends
  assert.deepStrictEqual(out.fenced[1], [['run_command', { command: 'mkdir -p lib' }]]);
  assert.strictEqual(out.fenced[2], 'Sure.\n```json\n{"name": "run_command", "arguments": {"command": "mkdir -p lib"}}\n```\n'.length);
  assert.deepStrictEqual(out.pycode, ['py:\n```python\nprint({"name": 1})\n```\nok', [], null]);
  assert.strictEqual(out.holding, 'x\n');
  // Sage Pro and Flash (Gemma 4 on MLX): Gemma's turns, any thinking hidden
  assert.deepStrictEqual(out.gscan, ['Hi there', [], null]);
  assert.strictEqual(out.gturn, '<|turn>user\nhey<turn|>\n<|turn>model\n');
  // Sage Ultra (Qwen3.8-27B): nothing shows while it thinks; then the answer, and
  // XML tool calls, cut where the call ends (one newline trimmed round each value)
  assert.deepStrictEqual(out.uthink, ['', [], null]);
  // …and its thinking, for the app to show apart (an end tag still coming is held back)
  assert.deepStrictEqual(out.uthought, ['They want a sum.', 'They want a sum.']);
  assert.strictEqual(out.gthought, 'plan itmore');
  assert.deepStrictEqual(out.uanswer, ['It is 4.', [], null]);
  assert.deepStrictEqual(out.ucall.slice(0, 2), ['Let me look.\n', [['write_file', { path: 'a.py', content: 'x = 1\n' }]]]);
  assert.strictEqual(out.ucall[2], 'plan\n</think>\n\nLet me look.\n<tool_call>\n<function=write_file>\n<parameter=path>\na.py\n</parameter>\n<parameter=content>\nx = 1\n\n</parameter>\n</function>\n</tool_call>'.length);
  assert.deepStrictEqual(out.uwait, ['Let me look.', [], null]);
  assert.strictEqual(out.uturn, '<|im_start|>user\nhey<|im_end|>\n<|im_start|>assistant\n<think>\n');
  // Sage Lite in a chat (Qwen3-1.7B): ChatML with thinking off, no tools
  assert.deepStrictEqual(out.qscan, ['Hi there.', [], null]);
  assert.strictEqual(out.qturn, '<|im_start|>user\nhey<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
  // Sage Lite in sage code (Ministral 3): [TOOL_CALLS]name[ARGS]{json}, cut where the JSON ends
  assert.deepStrictEqual(out.mcall, ['Let me look.', [['read_file', { path: 'a.py' }]], 'Let me look.[TOOL_CALLS]read_file[ARGS]{"path": "a.py"}'.length]);
  assert.deepStrictEqual(out.mwait, ['Let me look.', [], null]);
  assert.deepStrictEqual(out.mplain, ['Done.', [], null]);
  assert.strictEqual(out.thinking, ''); // not even a newline while it thinks
  // Gemma on MLX calls tools as on PyTorch: cut where the call ends, the result in the same turn
  assert.deepStrictEqual(out.gcall, ['Let me look.', [['read_file', { path: 'a.py' }]], 'Let me look.<|tool_call>call:read_file{path:<|"|>a.py<|"|>}<tool_call|>'.length]);
  assert.strictEqual(out.ganswer, '<|tool_response>response:read_file{result:<|"|>x = 1<|"|>}<tool_response|>');
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

test('without room for Pro, Sage picks Flash unless a model was asked for', () => {
  const gemma = require('../src/gemma');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-models-'));
  const was = { ...process.env };
  try {
    process.env.MAXSHELL_GEMMA = dir;
    process.env.MAXSHELL_GEMMA_PYTHON = process.execPath;
    const flash = path.join(dir, 'flash');
    fs.mkdirSync(flash);
    for (const f of [...gemma.FILES, 'model.safetensors']) fs.writeFileSync(path.join(flash, f), '');
    process.env.MAXSHELL_SAGE_FREE = '20';
    const auto = gemma.fallback('e4b', false);
    assert.strictEqual(auto.key, 'e2b');
    assert.match(auto.why, /20% of memory is free and Sage Pro needs 30%/);
    assert.strictEqual(gemma.fallback('e4b', true).key, 'e4b');
    process.env.MAXSHELL_SAGE_FREE = '55';
    assert.strictEqual(gemma.fallback('e4b', false).key, 'e4b');
    fs.rmSync(path.join(flash, 'model.safetensors'));
    process.env.MAXSHELL_SAGE_FREE = '20';
    assert.strictEqual(gemma.fallback('e4b', false).key, 'e4b'); // E2B isn't set up
    delete process.env.MAXSHELL_SAGE_MODEL;
    assert.strictEqual(gemma.pick(['hi']).chosen, false);
    assert.strictEqual(gemma.pick(['--e4b', 'hi']).chosen, true);
    const a = app({ notice: auto.why });
    assert.match(text(render(a, 90, 26, 0)).replace(/\s+/g, ' '), /this is Sage Flash, the lighter model/);
    assert.strictEqual(gemma.pick(['--flash', 'hi']).key, 'e2b');
    assert.strictEqual(gemma.pick(['--lite', 'hi']).key, 'lite');
    assert.strictEqual(gemma.MODELS.lite.label, 'Sage Lite');
    assert.strictEqual(gemma.MODELS.e2b.label, 'Sage Flash');
    assert.strictEqual(gemma.pick(['--ultra', 'hi']).key, 'ultra');
    assert.strictEqual(gemma.MODELS.ultra.label, 'Sage Ultra');
    assert.ok(!/Gemma/.test(text(render(app(), 90, 26, 0))));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in was)) delete process.env[k];
    Object.assign(process.env, was);
    fs.rmSync(dir, { recursive: true });
  }
});

test('sage image: options, file names that never overwrite, progress', () => {
  const img = require('../src/sageimage');
  const o = img.parseArgs(['--size', '1000x700', '--steps', '8', '--seed', '7', 'a', 'red', 'panda']);
  assert.deepStrictEqual([o.prompt, o.width, o.height, o.steps, o.seed], ['a red panda', 992, 704, 8, 7]);
  assert.match(img.parseArgs([]).error, /say what to draw/);
  assert.match(img.parseArgs(['--size', 'big', 'x']).error, /WIDTHxHEIGHT/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-img-'));
  const first = img.outputPath('A red panda, reading!', dir);
  assert.strictEqual(path.basename(first), 'sage-a-red-panda-reading.png');
  fs.writeFileSync(first, 'x');
  assert.strictEqual(path.basename(img.outputPath('A red panda, reading!', dir)), 'sage-a-red-panda-reading-2.png');
  assert.deepStrictEqual(img.progress(' 35%|███▌ | 7/20 [00:41<01:16]\r 40%|████ | 8/20 [00:47<01:10'), { step: 8, total: 20 });
  assert.ok(img.argv({ ...o }, '/tmp/x.png', 20).includes('--low-ram'));
  assert.ok(!img.argv({ ...o }, '/tmp/x.png', 80).includes('--low-ram'));
  fs.rmSync(dir, { recursive: true });
});

test('a background image job reports progress, then the saved picture', () => {
  const img = require('../src/sageimage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-img-'));
  process.env.MAXSHELL_IMAGE_BIN = path.join(__dirname, 'fake-mflux.js');
  try {
    const job = new img.Job(img.parseArgs(['--steps', '5', 'a', 'cat']), dir);
    let p;
    for (let i = 0; i < 300; i++) { p = job.poll(); if (p.state !== 'running') break; sleepSync(20); }
    assert.strictEqual(p.state, 'done');
    assert.deepStrictEqual([p.step, p.total], [5, 5]);
    assert.ok(fs.statSync(path.join(dir, 'sage-a-cat.png')).size > 0);
    job.cleanup();
    const bad = new img.Job(img.parseArgs(['please', 'fail']), dir);
    for (let i = 0; i < 300; i++) { p = bad.poll(); if (p.state !== 'running') break; sleepSync(20); }
    assert.strictEqual(p.state, 'failed');
    assert.match(p.error, /out of memory/);
    bad.cleanup();
  } finally {
    delete process.env.MAXSHELL_IMAGE_BIN;
    fs.rmSync(dir, { recursive: true });
  }
});

test('/image draws in the background while the chat goes on', () => {
  const polls = [{ state: 'running', step: 0, total: 20 }, { state: 'running', step: 7, total: 20 }, { state: 'done', step: 20, total: 20 }];
  const job = { out: path.join(os.tmpdir(), 'sage-a-fox.png'), stopped: false, poll: () => polls.shift() || { state: 'done', step: 20, total: 20 }, stop() { this.stopped = true; }, cleanup() {} };
  const a = app({ startImage: () => job });
  a.onEvent({ ev: 'ready' });
  a.setInput('/image a fox in the snow');
  a.submit();
  assert.ok(a.drawing());
  // the model that's chatting writes the detailed prompt first, apart from the chat
  assert.match(text(render(a, 90, 24, 0)), /Sage Pro is writing a detailed prompt…/);
  assert.match(text(render(a, 90, 24, 0)).split('\n')[0], /writing a prompt/);
  const sent = a.engine.sent.find((c) => c.op === 'image-prompt');
  assert.deepStrictEqual([sent.prompt, sent.edit], ['a fox in the snow', false]);
  a.tick(); // nothing to poll yet
  a.onEvent({ ev: 'image-prompt', id: sent.id, text: 'A red fox in deep snow, soft morning light, a photo.' });
  assert.strictEqual(a.items.find((i) => i.type === 'image').detailed, 'A red fox in deep snow, soft morning light, a photo.');
  a.tick();
  a.tick();
  let r = render(a, 90, 24, 0);
  assert.match(text(r), /● Image 768×768 {2}7\/20 ━+[\s\S]*“a fox in the snow”/);
  assert.match(text(r).split('\n')[0], /drawing 7\/20/);
  fits(render(a, 40, 14, 0), 40);
  a.setInput('/image another');
  a.submit();
  assert.match(a.items[a.items.length - 1].text, /one picture at a time/);
  a.send('meanwhile, a question'); // chatting still works
  assert.strictEqual(a.status, 'thinking');
  a.tick();
  r = render(a, 90, 24, 0);
  assert.match(text(r), /saved .*sage-a-fox\.png · 0s/);
  assert.match(text(r), /✎ A red fox in deep snow/);
  assert.strictEqual(a.drawing(), null);
  // /image --exact draws from the words at once
  const d = app({ startImage: (o) => { d.got = o; return job; } });
  d.onEvent({ ev: 'ready' });
  d.image('--exact a heron');
  assert.strictEqual(d.got.prompt, 'a heron');
  // Ctrl-C while Sage writes the prompt stops it, and nothing is drawn
  const e = app({ startImage: () => { throw new Error('should not draw'); } });
  e.onEvent({ ev: 'ready' });
  let interrupted = false;
  e.engine.interrupt = () => { interrupted = true; };
  e.image('a moth');
  e.key({ name: 'c', ctrl: true });
  assert.ok(interrupted);
  assert.strictEqual(e.items[0].state, 'stopped');
  e.onEvent({ ev: 'image-prompt', id: 1, text: 'late', stopped: true });
  assert.strictEqual(e.items[0].state, 'stopped');
  // not set up: says how
  const b = app();
  b.setInput('/image x');
  b.submit();
  assert.match(b.items[b.items.length - 1].text, /sage image --setup/);
  // ^C stops a picture being drawn
  const c = app({ startImage: () => ({ ...job, poll: () => ({ state: 'running', step: 1, total: 20 }) }) });
  c.onEvent({ ev: 'ready' });
  c.image('--exact a boat');
  c.key({ name: 'c', ctrl: true });
  assert.strictEqual(c.items[0].state, 'stopped');
  assert.strictEqual(c.done, false);
});

test('sage image from the shell saves a PNG here and never overwrites', () => {
  const sh = path.join(__dirname, '..', 'bin', 'maxshell.js');
  const gem = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-gem-'));
  for (const p of ['transformer', 'text_encoder', 'vae']) fs.mkdirSync(path.join(gem, 'image', p), { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-work-'));
  const env = { ...process.env, MAXSHELL_SETUP: '0', MAXSHELL_GEMMA: gem, MAXSHELL_IMAGE_BIN: path.join(__dirname, 'fake-mflux.js'), MAXSHELL_SAGE_FREE: '80' };
  const r = spawnSync('node', [sh, '-c', `cd ${work} && sage image --steps 3 a tiny boat`], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved sage-a-tiny-boat\.png/);
  assert.ok(fs.existsSync(path.join(work, 'sage-a-tiny-boat.png')));
  const again = spawnSync('node', [sh, '-c', `cd ${work} && sage image -o sage-a-tiny-boat.png a tiny boat`], { env, encoding: 'utf8' });
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /already there/);
  const help = spawnSync('node', [sh, '-c', 'sage image --help'], { env, encoding: 'utf8' });
  assert.match(help.stdout, /Research License/);
  fs.rmSync(gem, { recursive: true });
  fs.rmSync(work, { recursive: true });
});

test('the models: Qwen3.8 for Ultra, Gemma 4 for Pro and Flash; Lite differs in sage code', () => {
  const gemma = require('../src/gemma');
  for (const mode of ['chat', 'code']) {
    assert.strictEqual(gemma.modelFor('ultra', mode).repo, 'mlx-community/Qwen3.8-27B-4bit');
    assert.strictEqual(gemma.modelFor('e4b', mode).repo, 'mlx-community/gemma-4-e4b-it-4bit');
    assert.strictEqual(gemma.modelFor('e2b', mode).repo, 'mlx-community/gemma-4-e2b-it-4bit');
  }
  assert.strictEqual(gemma.modelFor('lite', 'chat').repo, 'mlx-community/Qwen3-1.7B-4bit');
  assert.strictEqual(gemma.modelFor('lite', 'code').repo, 'mlx-community/Ministral-3-3B-Instruct-2512-4bit');
  const sh = path.join(__dirname, '..', 'bin', 'maxshell.js');
  const gem = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-ultra-'));
  const env = { ...process.env, MAXSHELL_SETUP: '0', MAXSHELL_GEMMA: gem, MAXSHELL_GEMMA_PYTHON: process.execPath };
  const r = spawnSync('node', [sh, '-c', 'sage --ultra hello'], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Sage Ultra isn’t set up — run: sage --ultra --setup/);
  const c = spawnSync('node', [sh, '-c', 'sage code --lite hello'], { env, encoding: 'utf8' });
  assert.match(c.stderr, /Sage Lite isn’t set up — run: sage code --lite --setup/);
  // the shards the index names must all be there
  const d = path.join(gem, 'ultra');
  fs.mkdirSync(d);
  for (const f of gemma.FILES) fs.writeFileSync(path.join(d, f), '{}');
  fs.writeFileSync(path.join(d, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { a: 'model-1.safetensors', b: 'model-2.safetensors' } }));
  fs.writeFileSync(path.join(d, 'model-1.safetensors'), '');
  process.env.MAXSHELL_GEMMA = gem;
  process.env.MAXSHELL_GEMMA_PYTHON = process.execPath;
  try {
    assert.ok(!gemma.ready(gemma.MODELS.ultra));
    fs.writeFileSync(path.join(d, 'model-2.safetensors'), '');
    assert.ok(gemma.ready(gemma.MODELS.ultra));
  } finally {
    delete process.env.MAXSHELL_GEMMA;
    delete process.env.MAXSHELL_GEMMA_PYTHON;
    fs.rmSync(gem, { recursive: true });
  }
  // the dropdown: Ultra is the smartest; Lite is smaller in a chat than in sage code
  const a = app();
  a.onEvent({ ev: 'ready' });
  a.openMenu();
  assert.match(text(render(a, 90, 24, 0)), /Sage Ultra[\s\S]*smartest[\s\S]*Sage Lite[\s\S]*~1 GB/);
  a.menu = null;
  a.setInput('/model ultra');
  a.submit();
  assert.strictEqual(a.model, 'ultra');
  assert.strictEqual(a.started[a.started.length - 1].key, 'ultra');
  const b = app({ mode: 'code' });
  b.onEvent({ ev: 'ready' });
  b.openMenu();
  assert.match(text(render(b, 90, 24, 0)), /Sage Ultra[\s\S]*smartest[\s\S]*Sage Lite[\s\S]*~3 GB/);
  b.menu = null;
  b.setInput('/model lite');
  b.submit();
  assert.strictEqual(b.model, 'lite');
  b.setInput('/model flash');
  b.submit();
  assert.strictEqual(b.model, 'e2b');
  b.setInput('/model pro');
  b.submit();
  assert.strictEqual(b.model, 'e4b');
});

test('image chat: the first message draws, each one after edits the latest picture', () => {
  const { IDLE } = require('../src/sage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-imgchat-'));
  const PNG = makePng();
  const started = [];
  const startImage = (o) => {
    const out = path.join(root, o.output);
    started.push({ ...o, out });
    return { out, poll: () => { fs.writeFileSync(out, PNG); return { state: 'done', step: o.steps, total: o.steps }; }, stop() {}, cleanup() {} };
  };
  const a = new SageApp({ mode: 'image', root, model: 'image', models: [], start: () => IDLE, startImage });
  assert.strictEqual(a.status, 'ready');
  let r = render(a, 90, 26, 0);
  assert.match(text(r), /change it by talking to it/);
  assert.match(text(r).split('\n')[0], /✦ Sage {2}image .*◆ Sage Image/);
  assert.match(text(r), /Describe a picture…/);
  a.setInput('a fox in the snow');
  a.submit();
  assert.deepStrictEqual([started[0].prompt, started[0].images, started[0].output], ['a fox in the snow', null, 'sage-a-fox-in-the-snow.png']);
  a.tick();
  assert.strictEqual(a.picture, path.join(root, 'sage-a-fox-in-the-snow.png'));
  r = render(a, 90, 40, 0);
  assert.match(text(r), /● Image 768×768 {2}saved sage-a-fox-in-the-snow\.png/);
  assert.match(text(r), /▀/); // the picture, in half blocks
  assert.ok(r.hits.some((h) => h.action === 'open'));
  assert.match(text(r), /Say how to change it…/);
  a.setInput('make it night');
  a.submit();
  assert.deepStrictEqual([started[1].prompt, started[1].images, started[1].output], ['make it night', [path.join(root, 'sage-a-fox-in-the-snow.png')], 'sage-a-fox-in-the-snow-2.png']);
  a.tick();
  assert.strictEqual(a.picture, path.join(root, 'sage-a-fox-in-the-snow-2.png'));
  assert.match(text(render(a, 90, 60, 0)), /● Edit 768×768 {2}saved sage-a-fox-in-the-snow-2\.png/);
  for (const [c, rr] of [[90, 30], [40, 14], [24, 10]]) fits(render(a, c, rr, 0), c);
  a.setInput('/size 512');
  a.submit();
  a.setInput('/new');
  a.submit();
  assert.strictEqual(a.picture, null);
  a.setInput('a boat');
  a.submit();
  assert.deepStrictEqual([started[2].width, started[2].images], [512, null]);
  a.key({ name: 'o', ctrl: true });
  assert.strictEqual(a.menu, null);
  fs.rmSync(root, { recursive: true });
});

test('image chat: a picture of yours, dragged in or by /edit, is what edits change', () => {
  const { IDLE } = require('../src/sage');
  const img = require('../src/sageimage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-mine-'));
  const PNG = makePng();
  fs.writeFileSync(path.join(root, 'my photo.png'), PNG);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hi');
  // shape and dropped paths
  assert.deepStrictEqual(img.fitSize(4000, 3000, 768), { width: 768, height: 576 });
  assert.deepStrictEqual(img.fitSize(1080, 1920, 512), { width: 288, height: 512 });
  assert.strictEqual(img.droppedPath(`${root}/my\\ photo.png`), path.join(root, 'my photo.png'));
  assert.strictEqual(img.droppedPath(`'${root}/my photo.png'`), path.join(root, 'my photo.png'));
  assert.strictEqual(img.droppedPath('my photo.png', root), path.join(root, 'my photo.png'));
  assert.strictEqual(img.droppedPath('a fox in the snow'), null);
  assert.strictEqual(img.droppedPath(path.join(root, 'notes.txt')), null);
  const p = img.prepare('my photo.png', root);
  assert.deepStrictEqual([p.width, p.height, p.source], [2, 2, path.join(root, 'my photo.png')]);
  assert.notStrictEqual(p.file, p.source); // a copy: the original is never touched
  assert.match(img.prepare('nope.jpg', root).error, /no nope\.jpg/);
  assert.match(img.prepare('notes.txt', root).error, /can read/);
  const o = img.parseArgs(['--edit', 'a.jpg', 'make', 'it', 'night']);
  assert.deepStrictEqual([o.images, o.prompt, o.sized], [['a.jpg'], 'make it night', false]);
  assert.strictEqual(img.parseArgs(['--edit', 'a.jpg'], { chat: true }).prompt, '');
  // the app
  const started = [];
  const startImage = (opts) => {
    const out = path.join(root, opts.output);
    started.push(opts);
    return { out, poll: () => { fs.writeFileSync(out, PNG); return { state: 'done', step: 1, total: 1 }; }, stop() {}, cleanup() {} };
  };
  const a = new SageApp({ mode: 'image', root, model: 'image', models: [], start: () => IDLE, startImage });
  assert.match(text(render(a, 90, 30, 0)), /drag it in here or type \/edit/);
  a.setInput(`${root}/my\\ photo.png`); // what a terminal pastes when it's dragged in
  a.submit();
  assert.strictEqual(started.length, 0);
  let r = render(a, 90, 40, 0);
  assert.match(text(r), /● Your picture 768×768 .*my photo\.png · say how to change it/);
  assert.ok(r.hits.some((h) => h.action === 'open' && h.file === path.join(root, 'my photo.png')));
  a.setInput('make it night');
  a.submit();
  assert.deepStrictEqual([started[0].images, started[0].output], [[a.items[0].out], 'sage-my-photo.png']);
  a.tick();
  assert.strictEqual(a.picture, path.join(root, 'sage-my-photo.png'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'my photo.png')).equals(PNG), true);
  for (const [c, rr] of [[90, 30], [40, 14], [24, 10]]) fits(render(a, c, rr, 0), c);
  a.fitted = img.fitSize(1600, 1200, 768);
  a.setInput('/size 512'); // the long side: the picture keeps its shape
  a.submit();
  assert.deepStrictEqual(a.fitted, { width: 512, height: 384 });
  a.setInput('/size 640x640');
  a.submit();
  assert.strictEqual(a.fitted, null);
  a.setInput('/edit nope.jpg');
  a.submit();
  assert.match(a.items[a.items.length - 1].text, /Can’t edit that: there’s no nope\.jpg/);
  a.setInput('/edit');
  a.submit();
  assert.match(a.items[a.items.length - 1].text, /drag it in/);
  fs.rmSync(root, { recursive: true });
});

test('sage image --edit changes a picture of yours from the shell', () => {
  const sh = path.join(__dirname, '..', 'bin', 'maxshell.js');
  const gem = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-gem-'));
  for (const p of ['transformer', 'text_encoder', 'vae']) fs.mkdirSync(path.join(gem, 'image', p), { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-work-'));
  fs.writeFileSync(path.join(work, 'cat.png'), makePng());
  const env = { ...process.env, MAXSHELL_SETUP: '0', MAXSHELL_GEMMA: gem, MAXSHELL_IMAGE_BIN: path.join(__dirname, 'fake-mflux.js'), MAXSHELL_SAGE_FREE: '80' };
  const r = spawnSync('node', [sh, '-c', `cd ${work} && sage image --edit cat.png --steps 2 give it a hat`], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /editing 768×768.*saved sage-give-it-a-hat\.png/s);
  const bad = spawnSync('node', [sh, '-c', `cd ${work} && sage image --edit missing.jpg a hat`], { env, encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /there’s no missing\.jpg/);
  fs.rmSync(gem, { recursive: true });
  fs.rmSync(work, { recursive: true });
});

test('Sage writes a detailed prompt first, and the image model draws from it', () => {
  const img = require('../src/sageimage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-writer-'));
  const writer = { label: 'Sage Pro', cmd: [process.execPath, path.join(__dirname, 'fake-sage-writer.js')], env: {} };
  process.env.MAXSHELL_IMAGE_BIN = path.join(__dirname, 'fake-mflux.js');
  const finish = (job) => { let p; for (let i = 0; i < 300; i++) { p = job.poll(); if (p.state !== 'running') break; sleepSync(20); } return p; };
  try {
    const job = new img.Job(img.parseArgs(['--steps', '2', 'a', 'cat']), dir, { writer });
    assert.strictEqual(job.poll().phase, 'prompt');
    let p = finish(job);
    assert.strictEqual(p.state, 'done');
    assert.strictEqual(p.detailed, 'DETAILED: a cat, in warm evening light, a wide shot, a photo.');
    assert.match(fs.readFileSync(job.log, 'utf8'), /prompt: DETAILED: a cat/); // what the image model was given
    assert.ok(fs.existsSync(path.join(dir, 'sage-a-cat.png'))); // named after your words
    job.cleanup();
    // Sage can't run: the picture is drawn from your words, and says why
    const mute = new img.Job(img.parseArgs(['--steps', '1', 'a', 'mute', 'swan']), dir, { writer });
    p = finish(mute);
    assert.strictEqual(p.state, 'done');
    assert.match(p.unwritten, /only 12% of memory is free/);
    assert.match(fs.readFileSync(mute.log, 'utf8'), /prompt: a mute swan\n/);
    mute.cleanup();
    // an edit tells Sage what the picture shows
    const edit = new img.Job({ ...img.parseArgs(['--steps', '1', 'make', 'it', 'night']), images: [path.join(dir, 'sage-a-cat.png')], context: 'a cat on a mat' }, dir, { writer });
    p = finish(edit);
    assert.strictEqual(p.detailed, 'EDIT: make it night; keep everything else. [context: a cat on a mat]');
    edit.cleanup();
  } finally {
    delete process.env.MAXSHELL_IMAGE_BIN;
    fs.rmSync(dir, { recursive: true });
  }
});

test('sage image from the shell: Sage’s prompt first, --exact skips it', () => {
  const sh = path.join(__dirname, '..', 'bin', 'maxshell.js');
  const gem = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-gem-'));
  for (const p of ['transformer', 'text_encoder', 'vae']) fs.mkdirSync(path.join(gem, 'image', p), { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-work-'));
  const env = { ...process.env, MAXSHELL_SETUP: '0', MAXSHELL_GEMMA: gem, MAXSHELL_IMAGE_BIN: path.join(__dirname, 'fake-mflux.js'), MAXSHELL_SAGE_WRITER: path.join(__dirname, 'fake-sage-writer.js'), MAXSHELL_SAGE_FREE: '80' };
  const r = spawnSync('node', [sh, '-c', `cd ${work} && sage image --steps 1 a tiny boat`], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sage Pro is writing a detailed prompt…\n {2}DETAILED: a tiny boat, in warm evening light/);
  assert.match(r.stderr, /prompt: DETAILED: a tiny boat/);
  assert.match(r.stdout, /saved sage-a-tiny-boat\.png/);
  const exact = spawnSync('node', [sh, '-c', `cd ${work} && sage image --exact --steps 1 a tiny boat`], { env, encoding: 'utf8' });
  assert.ok(!/writing a detailed prompt/.test(exact.stdout));
  assert.match(exact.stderr, /prompt: a tiny boat\n/);
  const mute = spawnSync('node', [sh, '-c', `cd ${work} && sage image --steps 1 a mute swan`], { env, encoding: 'utf8' });
  assert.match(mute.stdout, /\(only 12% of memory is free — drawing from your words\)/);
  fs.rmSync(gem, { recursive: true });
  fs.rmSync(work, { recursive: true });
});

test('image chat shows Sage’s prompt, and edits are written knowing the picture', () => {
  const { IDLE } = require('../src/sage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-scene-'));
  const PNG = makePng();
  const started = [];
  let polled = { phase: 'prompt' };
  const startImage = (o) => {
    const out = path.join(root, o.output);
    started.push(o);
    return {
      out, writer: o.exact ? null : { label: 'Sage Pro' }, stop() {}, cleanup() {},
      poll: () => {
        if (polled.phase === 'prompt') return { state: 'running', phase: 'prompt', step: 0, total: 8 };
        fs.writeFileSync(out, PNG);
        return { state: 'done', phase: 'draw', step: 8, total: 8, detailed: o.exact ? null : `DETAILED ${o.prompt}` };
      },
    };
  };
  const a = new SageApp({ mode: 'image', root, model: 'image', models: [], start: () => IDLE, startImage });
  a.setInput('a fox');
  a.submit();
  a.tick();
  assert.match(text(render(a, 90, 30, 0)), /● Image 768×768 {2}Sage Pro is writing a detailed prompt…/);
  polled = { phase: 'draw' };
  a.tick();
  let r = text(render(a, 90, 40, 0));
  assert.match(r, /✎ DETAILED a fox/);
  assert.strictEqual(a.scene, 'DETAILED a fox');
  a.setInput('make it night');
  a.submit();
  assert.strictEqual(started[1].context, 'DETAILED a fox');
  a.tick();
  a.setInput('add snow');
  a.submit();
  assert.strictEqual(started[2].context, 'DETAILED a fox It has since been changed: make it night.');
  a.tick();
  a.setInput('/exact');
  a.submit();
  a.setInput('/new');
  a.submit();
  assert.deepStrictEqual([a.scene, a.changes], [null, []]);
  a.setInput('a heron');
  a.submit();
  assert.strictEqual(started[3].exact, true);
  // a long prompt is cut to four lines
  a.items.push({ type: 'image', state: 'done', size: '768×768', prompt: 'x', out: path.join(root, 'none.png'), seconds: 1, detailed: 'word '.repeat(200) });
  r = text(render(a, 60, 200, 0));
  const said = r.split('\n').filter((l) => /word word/.test(l));
  assert.strictEqual(said.length, 4);
  assert.match(said[0], /✎ word/);
  assert.match(said[3], /…$/);
  for (const [c, rr] of [[90, 30], [40, 14], [24, 10]]) fits(render(a, c, rr, 0), c);
  fs.rmSync(root, { recursive: true });
});

test('the engine writes /image prompts on request, apart from the chat', () => {
  const e = new Engine([process.execPath, path.join(__dirname, 'fake-sage-engine.js'), '{commands}', 'chat'], { cwd: os.tmpdir(), env: process.env });
  try {
    e.send({ op: 'image-prompt', id: 3, prompt: 'a kite', edit: false, context: null });
    let got = null;
    for (let i = 0; i < 200 && !got; i++) { got = e.poll().find((ev) => ev.ev === 'image-prompt'); if (!got) sleepSync(20); }
    assert.deepStrictEqual(got, { ev: 'image-prompt', id: 3, text: 'DETAILED a kite', stopped: false });
  } finally { e.close(); }
});

test('sage video: options, frames, the command line, progress', () => {
  const video = require('../src/sagevideo');
  const o = video.parseArgs(['--seconds', '3', '--size', '640x360', 'a', 'kite']);
  assert.deepStrictEqual([o.prompt, o.width, o.height, o.seconds], ['a kite', 640, 352, 3]);
  assert.deepStrictEqual([video.frames(2), video.frames(5), video.frames(0.1)], [49, 121, 5]);
  // any length: made in segments of up to SEGMENT seconds
  const at = (sec) => { const p = video.plan(sec); return [p.segments, p.frames, Math.round(p.seconds * 10) / 10]; };
  assert.deepStrictEqual(at(2), [1, 49, 2]);
  assert.deepStrictEqual(at(30), [15, 49, 30]); // 15 parts, sharing their joining frames
  assert.strictEqual(video.plan(3).segments, 2);
  assert.ok(Math.abs(video.plan(7).seconds - 7) < 0.4); // each part is a whole number of 4-frame steps
  assert.strictEqual(video.parseArgs(['--seconds', '600', 'x']).seconds, 600);
  assert.match(video.parseArgs(['--seconds', '0', 'x']).error, /how long/);
  const long = video.argv({ ...video.parseArgs(['--seconds', '30', 'x']), seed: 1 }, '/tmp/o.mp4');
  assert.strictEqual(long[long.indexOf('--segments') + 1], '15');
  assert.ok(!video.argv({ ...video.parseArgs(['x']), seed: 1 }, '/tmp/o.mp4').includes('--segments'));
  assert.deepStrictEqual(video.progress('segment 1/3\nDiffusion: 4/4 [00:01\nDecoding with VAE...\nsegment 2/3\nDiffusion:  50%| 2/4 [00:30'), { stage: 'denoise', step: 2, total: 4, segment: 2, segments: 3 });
  assert.match(video.parseArgs([]).error, /say what to film/);
  assert.match(video.parseArgs(['--size', '9000x10', 'x']).error, /256 to 1280/);
  const a = video.argv({ ...o, seed: 3, promptFile: '/tmp/p.txt', images: ['/tmp/pic.png'] }, '/tmp/out.mp4');
  assert.match(a[1], /sagevideo\.py$/); // the launcher, which reads --prompt-file
  for (const [k, v] of [['--prompt-file', '/tmp/p.txt'], ['--num-frames', '37'], ['--segments', '2'], ['--seed', '3'], ['--output-path', '/tmp/out.mp4'], ['--image', '/tmp/pic.png'], ['--width', '640']]) assert.strictEqual(a[a.indexOf(k) + 1], v, k);
  assert.deepStrictEqual(video.progress('Loading T5 encoder...'), { stage: 'prompt', segment: 1, segments: 1 });
  assert.deepStrictEqual(video.progress('Diffusion:  25%|██| 3/12 [00:30'), { stage: 'denoise', step: 3, total: 12, segment: 1, segments: 1 });
  assert.strictEqual(video.progress('12/12 [01:00]\nDecoding with VAE...').stage, 'decode');
});

test('sage video from the shell: Sage’s prompt, then a clip here', () => {
  const sh = path.join(__dirname, '..', 'bin', 'maxshell.js');
  const gem = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-gem-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-work-'));
  fs.writeFileSync(path.join(work, 'pic.png'), makePng());
  const env = { ...process.env, MAXSHELL_SETUP: '0', MAXSHELL_GEMMA: gem, MAXSHELL_VIDEO_BIN: path.join(__dirname, 'fake-wan.js'), MAXSHELL_SAGE_WRITER: path.join(__dirname, 'fake-sage-writer.js'), MAXSHELL_SAGE_FREE: '80' };
  const r = spawnSync('node', [sh, '-c', `cd ${work} && sage video --steps 2 a paper boat`], { env: { ...env, MAXSHELL_AUDIO_BIN: path.join(__dirname, 'fake-mmaudio.js') }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /adding sound…\nsound 1\/1/);
  assert.strictEqual(fs.readFileSync(path.join(work, 'sage-a-paper-boat.mp4'), 'utf8'), 'not really an mp4+sound(a paper boat)');
  assert.match(r.stdout, /Sage Pro is writing a detailed prompt…\n {2}MOTION: a paper boat, the camera slowly pushes in\./);
  assert.match(r.stdout, /prompt: MOTION: a paper boat[\s\S]*frames: 49/);
  assert.match(r.stdout, /saved sage-a-paper-boat\.mp4/);
  assert.ok(fs.existsSync(path.join(work, 'sage-a-paper-boat.mp4')));
  const pic = spawnSync('node', [sh, '-c', `cd ${work} && sage video --exact --image pic.png --seconds 1 --steps 1 the leaves sway`], { env, encoding: 'utf8' });
  assert.strictEqual(pic.status, 0, pic.stderr);
  assert.ok(!/writing a detailed prompt/.test(pic.stdout));
  assert.match(pic.stdout, /silent: set up sound with sage video --setup/); // no sound model here
  assert.match(pic.stdout, /prompt: the leaves sway\nframes: 25\nimage: .*picture\.png/);
  const long = spawnSync('node', [sh, '-c', `cd ${work} && sage video --exact --seconds 5 --steps 1 a long walk`], { env, encoding: 'utf8' });
  assert.strictEqual(long.status, 0, long.stderr);
  assert.match(long.stdout, /filming 1280×704, 5 s in 3 parts of 2 s, 1 step — about \d+ minutes on an M3/);
  assert.match(long.stdout, /segment 1\/3[\s\S]*segment 3\/3/);
  const missing = spawnSync('node', [sh, '-c', `cd ${work} && sage video --image nope.jpg x`], { env, encoding: 'utf8' });
  assert.match(missing.stderr, /there’s no nope\.jpg/);
  const unset = spawnSync('node', [sh, '-c', 'sage video a boat'], { env: { ...env, MAXSHELL_VIDEO_BIN: '' }, encoding: 'utf8' });
  assert.match(unset.stderr, /sage video --setup/);
  fs.rmSync(gem, { recursive: true });
  fs.rmSync(work, { recursive: true });
});

test('a background video job: Sage writes about motion, then Wan films it', () => {
  const video = require('../src/sagevideo');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-vjob-'));
  process.env.MAXSHELL_VIDEO_BIN = path.join(__dirname, 'fake-wan.js');
  process.env.MAXSHELL_AUDIO_BIN = path.join(__dirname, 'fake-mmaudio.js');
  const writer = { label: 'Sage Pro', cmd: [process.execPath, path.join(__dirname, 'fake-sage-writer.js')], env: {} };
  try {
    const job = video.job({ ...video.parseArgs(['--steps', '3', 'a', 'kite']), words: 'a kite' }, dir, { writer });
    let p;
    for (let i = 0; i < 300; i++) { p = job.poll(); if (p.state !== 'running') break; sleepSync(20); }
    assert.strictEqual(p.state, 'done');
    assert.strictEqual(p.stage, 'sound'); // the last thing it did
    assert.strictEqual(p.detailed, 'MOTION: a kite, the camera slowly pushes in.');
    assert.strictEqual(job.out, path.join(dir, 'sage-a-kite.mp4'));
    assert.match(fs.readFileSync(job.log, 'utf8'), /prompt: MOTION: a kite/);
    assert.strictEqual(fs.readFileSync(job.out, 'utf8'), 'not really an mp4+sound(a kite)'); // MMAudio got the words, not Sage's prompt
    job.cleanup();
    // no sound asked for: none added
    const quiet = video.job({ ...video.parseArgs(['--no-sound', '--steps', '1', 'a', 'mime']) }, dir);
    for (let i = 0; i < 300; i++) { p = quiet.poll(); if (p.state !== 'running') break; sleepSync(20); }
    assert.strictEqual(fs.readFileSync(quiet.out, 'utf8'), 'not really an mp4');
    quiet.cleanup();
  } finally {
    delete process.env.MAXSHELL_VIDEO_BIN;
    delete process.env.MAXSHELL_AUDIO_BIN;
    fs.rmSync(dir, { recursive: true });
  }
});

test('video chat: film, change it, keep going — with progress, sound and a frame', () => {
  const { IDLE } = require('../src/sage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-vchat-'));
  const PNG = makePng();
  const started = [];
  let polls = [];
  const startVideo = (o) => {
    const out = path.join(root, o.output);
    started.push(o);
    polls = [
      { state: 'running', phase: 'prompt', step: 0, total: 4 },
      { state: 'running', phase: 'draw', stage: 'denoise', step: 2, total: 4, segment: 2, segments: 3, detailed: `DETAILED ${o.prompt}` },
      { state: 'running', phase: 'draw', stage: 'sound', step: 4, total: 4, segment: 3, segments: 3, detailed: `DETAILED ${o.prompt}` },
      { state: 'done', phase: 'draw', stage: 'sound', step: 4, total: 4, detailed: o.exact ? null : `DETAILED ${o.prompt}` },
    ];
    return {
      out, writer: o.exact ? null : { label: 'Sage Pro' }, stop() {}, cleanup() {},
      poll: () => { const p = polls.shift() || { state: 'done' }; if (p.state === 'done') { fs.writeFileSync(out, 'mp4'); fs.writeFileSync(o.poster, PNG); } return p; },
    };
  };
  const a = new SageApp({ mode: 'video', root, model: 'video', models: [], start: () => IDLE, startVideo });
  assert.strictEqual(a.status, 'ready');
  let r = render(a, 90, 26, 0);
  assert.match(text(r).split('\n')[0], /✦ Sage {2}video .*◆ Sage Video/);
  assert.match(text(r), /Sage films it, with sound/);
  assert.match(text(r), /Describe a clip…/);
  a.setInput('/seconds 6');
  a.submit();
  assert.match(a.items[a.items.length - 1].text, /3 parts of 2 s, about 54 minutes/);
  a.setInput('a puppy in sunflowers');
  a.submit();
  assert.deepStrictEqual([started[0].prompt, started[0].seconds, started[0].sound, started[0].output, started[0].previous], ['a puppy in sunflowers', 6, true, 'sage-a-puppy-in-sunflowers.mp4', undefined]);
  a.tick();
  assert.match(text(render(a, 90, 30, 0)), /● Clip 1280×704 · 6 s {2}Sage Pro is writing a detailed prompt…/);
  assert.match(text(render(a, 90, 30, 0)).split('\n')[0], /writing a prompt/);
  a.tick();
  r = text(render(a, 90, 30, 0));
  assert.match(r, /part 2\/3 · 2\/4 ━+/);
  assert.match(r.split('\n')[0], /filming part 2\/3/);
  assert.match(r, /✎ DETAILED a puppy in sunflowers/);
  a.tick();
  assert.match(text(render(a, 90, 30, 0)), /adding sound…/);
  a.tick();
  assert.strictEqual(a.clip, path.join(root, 'sage-a-puppy-in-sunflowers.mp4'));
  assert.strictEqual(a.scene, 'DETAILED a puppy in sunflowers');
  r = render(a, 90, 50, 0);
  assert.match(text(r), /saved sage-a-puppy-in-sunflowers\.mp4/);
  assert.match(text(r), /▀/); // a frame of it
  assert.ok(r.hits.some((h) => h.action === 'open' && h.file === a.clip)); // click to play
  assert.match(text(r), /“keep going”…/);
  // a change: a new version, Sage told what the clip shows
  a.setInput('make it night');
  a.submit();
  assert.deepStrictEqual([started[1].prompt, started[1].context, started[1].output], ['make it night', 'DETAILED a puppy in sunflowers', 'sage-a-puppy-in-sunflowers-2.mp4']);
  assert.strictEqual(started[1].words, 'a puppy in sunflowers'); // what the sound model hears about
  for (let i = 0; i < 4; i++) a.tick();
  assert.match(text(render(a, 90, 80, 0)), /● New version/);
  assert.strictEqual(a.scene, 'DETAILED make it night'); // Sage's new prompt has the change in it
  // keep going: carry on from the latest clip, same scene, no rewrite
  a.setInput('keep going');
  a.submit();
  assert.deepStrictEqual([started[2].previous, started[2].prompt, started[2].exact], [path.join(root, 'sage-a-puppy-in-sunflowers-2.mp4'), 'DETAILED make it night', true]);
  for (let i = 0; i < 4; i++) a.tick();
  assert.match(text(render(a, 90, 120, 0)), /● Longer 1280×704 · \+6 s/);
  a.setInput('/sound off');
  a.submit();
  a.setInput('/new');
  a.submit();
  assert.deepStrictEqual([a.clip, a.scene, a.changes], [null, null, []]);
  a.setInput('waves');
  a.submit();
  assert.strictEqual(started[3].sound, false);
  for (const [c, rr] of [[90, 30], [40, 14], [24, 10]]) fits(render(a, c, rr, 0), c);
  // not set up
  const b = new SageApp({ mode: 'video', root, model: 'video', models: [], start: () => IDLE });
  b.setInput('x');
  b.submit();
  assert.match(b.items[b.items.length - 1].text, /sage video --setup/);
  fs.rmSync(root, { recursive: true });
});

test('png: decodes a PNG and draws it in half blocks', () => {
  const png = require('../src/png');
  const PNG = makePng();
  const img = png.decode(PNG);
  assert.deepStrictEqual([img.width, img.height], [2, 2]);
  const t = png.thumbnail(img, 2, { truecolor: true });
  assert.strictEqual(t.length, 1);
  assert.strictEqual(ansi.width(t[0]), 2);
  assert.deepStrictEqual([...img.rgb], [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  assert.strictEqual(t[0], '\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀\x1b[38;2;0;255;0m\x1b[48;2;255;255;255m▀\x1b[0m'); // red over blue, green over white
  assert.strictEqual(png.to256([255, 0, 0]), 196);
  assert.strictEqual(png.to256([128, 128, 128]), 244);
  assert.throws(() => png.decode(Buffer.from('nope')));
});

if (failures) {
  console.error(`\n${failures} sage test(s) failed`);
  process.exit(1);
}
console.log('\nall sage tests passed');
