'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

const { Shell } = require('../src/interpreter');
const { LineEditor } = require('../src/lineeditor');
const { highlight } = require('../src/highlight');
const { completions, commonPrefix } = require('../src/complete');
const { expandPrompt, shortCwd } = require('../src/prompt');
const ansi = require('../src/ansi');

let failures = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(
      () => console.log(`ok - ${name}`),
      (e) => { failures++; console.error(`not ok - ${name}\n  ${e.message}`); },
    );
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok - ${name}\n  ${e.message}`);
  }
  return Promise.resolve();
}

class FakeInput extends EventEmitter {
  setRawMode() {}
  resume() {}
  pause() {}
}

class FakeOutput {
  constructor(columns = 80) { this.columns = columns; this.data = ''; }
  write(s) { this.data += s; }
}

const CHAR_KEYS = { ' ': 'space', '\r': 'return' };

function keysFor(text) {
  return [...text].map((ch) => ({ str: ch, key: { name: CHAR_KEYS[ch] || ch } }));
}

// Drives the editor with a sequence of keypresses and resolves its result.
function drive(events, { history = [], shell, columns = 80 } = {}) {
  const input = new FakeInput();
  const output = new FakeOutput(columns);
  const editor = new LineEditor({
    input,
    output,
    shell: shell || new Shell({ output: () => {}, error: () => {} }),
    highlight: (s) => s,
    complete: completions,
    history,
  });
  const promise = editor.read('% ', '');
  for (const ev of events) input.emit('keypress', ev.str, ev.key);
  return { promise, editor, output };
}

const ENTER = { str: '\r', key: { name: 'return' } };
const key = (name, extra = {}) => ({ str: '', key: { name, ...extra } });

async function main() {
  ansi.setEnabled(false);

  // --- line editing --------------------------------------------------------

  await test('typing a line and pressing enter returns it', async () => {
    const { promise } = drive([...keysFor('echo hi'), ENTER]);
    assert.deepStrictEqual(await promise, { line: 'echo hi' });
  });

  await test('backspace deletes before the cursor', async () => {
    const { promise } = drive([...keysFor('echo hix'), key('backspace'), ENTER]);
    assert.strictEqual((await promise).line, 'echo hi');
  });

  await test('left arrow and insert edits mid-line', async () => {
    const { promise } = drive([
      ...keysFor('echo ho'), key('left'), ...keysFor('e'), ENTER,
    ]);
    assert.strictEqual((await promise).line, 'echo heo');
  });

  await test('ctrl-a jumps to the start of the line', async () => {
    const { promise } = drive([
      ...keysFor('world'), key('a', { ctrl: true }), ...keysFor('hello '), ENTER,
    ]);
    assert.strictEqual((await promise).line, 'hello world');
  });

  await test('ctrl-u kills to the start, ctrl-k to the end', async () => {
    const { promise: p1 } = drive([...keysFor('rm -rf /'), key('u', { ctrl: true }), ...keysFor('ls'), ENTER]);
    assert.strictEqual((await p1).line, 'ls');

    const { promise: p2 } = drive([
      ...keysFor('echo keep drop'), key('left'), key('left'), key('left'), key('left'),
      key('k', { ctrl: true }), ENTER,
    ]);
    assert.strictEqual((await p2).line, 'echo keep ');
  });

  await test('ctrl-w deletes the previous word', async () => {
    const { promise } = drive([...keysFor('git commit bad'), key('w', { ctrl: true }), ENTER]);
    assert.strictEqual((await promise).line, 'git commit ');
  });

  await test('ctrl-c aborts and ctrl-d on an empty line is EOF', async () => {
    const { promise: aborted } = drive([...keysFor('half typed'), key('c', { ctrl: true })]);
    assert.deepStrictEqual(await aborted, { line: '', aborted: true });

    const { promise: eof } = drive([key('d', { ctrl: true })]);
    assert.deepStrictEqual(await eof, { line: '', eof: true });
  });

  // --- history and suggestions ---------------------------------------------

  await test('up arrow walks back through history', async () => {
    const { promise } = drive([key('up'), ENTER], { history: ['git status', 'ls -la'] });
    assert.strictEqual((await promise).line, 'ls -la');
  });

  await test('up twice then down returns to the newer entry', async () => {
    const { promise } = drive([key('up'), key('up'), key('down'), ENTER], {
      history: ['git status', 'ls -la'],
    });
    assert.strictEqual((await promise).line, 'ls -la');
  });

  await test('ghost suggestion is offered from history', () => {
    const { editor } = drive(keysFor('git co'), { history: ['git commit -m "fix"'] });
    assert.strictEqual(editor.suggestion, 'git commit -m "fix"');
  });

  await test('right arrow at end of line accepts the suggestion', async () => {
    const { promise } = drive([...keysFor('git co'), key('right'), ENTER], {
      history: ['git commit -m "fix"'],
    });
    assert.strictEqual((await promise).line, 'git commit -m "fix"');
  });

  await test('no suggestion when the cursor is not at the end', () => {
    const { editor } = drive([...keysFor('git co'), key('left')], {
      history: ['git commit -m "fix"'],
    });
    assert.strictEqual(editor.suggestion, '');
  });

  // --- completion ----------------------------------------------------------

  await test('tab completes a unique command to itself plus a space', async () => {
    const { promise } = drive([...keysFor('unfuncti'), key('tab'), ENTER]);
    assert.strictEqual((await promise).line, 'unfunction ');
  });

  await test('tab inserts the common prefix when ambiguous', async () => {
    const { editor } = drive([...keysFor('unf'), key('tab')]);
    assert.ok(editor.buf.startsWith('unf'), `got ${JSON.stringify(editor.buf)}`);
    assert.ok(editor.buf.length >= 'unf'.length);
  });

  await test('completions include builtins and local files', () => {
    const shell = new Shell({ output: () => {}, error: () => {} });
    const { items } = completions('ec', 2, shell);
    assert.ok(items.includes('echo'), 'expected echo among completions');

    const paths = completions('cat packa', 9, shell).items;
    assert.ok(paths.includes('package.json'), `expected package.json, got ${paths}`);
    const first = completions('packa', 5, shell).items;
    assert.ok(!first.includes('package.json'), 'a command position offers commands, not files');
  });

  await test('commonPrefix finds the shared start', () => {
    assert.strictEqual(commonPrefix(['printf', 'print', 'pri']), 'pri');
    assert.strictEqual(commonPrefix(['abc']), 'abc');
    assert.strictEqual(commonPrefix([]), '');
  });

  // --- highlighting --------------------------------------------------------

  await test('highlighting is a no-op when colour is disabled', () => {
    ansi.setEnabled(false);
    const shell = new Shell({ output: () => {}, error: () => {} });
    assert.strictEqual(highlight('echo "hi" | grep x', shell), 'echo "hi" | grep x');
  });

  await test('highlighting colours commands, strings, vars and operators', () => {
    ansi.setEnabled(true);
    const shell = new Shell({ output: () => {}, error: () => {} });

    const painted = highlight('echo "hi $USER" | grep x', shell);
    assert.ok(painted.includes('\x1b['), 'expected escape codes');
    assert.strictEqual(ansi.strip(painted), 'echo "hi $USER" | grep x');

    const unknown = highlight('definitelynotacommandxyz arg', shell);
    assert.ok(unknown.includes(ansi.fg('red')), 'unknown commands should be red');

    const known = highlight('echo arg', shell);
    assert.ok(!known.startsWith(ansi.fg('red')), 'known builtins should not be red');

    ansi.setEnabled(false);
  });

  await test('highlighting survives half-typed input', () => {
    ansi.setEnabled(true);
    const shell = new Shell({ output: () => {}, error: () => {} });
    for (const s of ['echo "unclosed', "echo 'unclosed", 'echo $(', 'echo ${', 'for i in', '| |', '#comment', '']) {
      const painted = highlight(s, shell);
      assert.strictEqual(ansi.strip(painted), s, `round-trip failed for ${JSON.stringify(s)}`);
    }
    ansi.setEnabled(false);
  });

  // --- prompt --------------------------------------------------------------

  await test('prompt escapes expand', () => {
    ansi.setEnabled(false);
    const shell = new Shell({ output: () => {}, error: () => {} });
    assert.strictEqual(expandPrompt('%%', shell), '%');
    assert.strictEqual(expandPrompt('%d', shell), shell.cwd);
    assert.strictEqual(expandPrompt('[%c]', shell), `[${require('path').basename(shell.cwd)}]`);
    assert.ok(/^\d\d:\d\d$/.test(expandPrompt('%T', shell)));
    assert.ok(expandPrompt('%V', shell).startsWith('node v'));
  });

  await test('cwd shortens to ~ under home', () => {
    assert.strictEqual(shortCwd('/Users/max/code', '/Users/max'), '~/code');
    assert.strictEqual(shortCwd('/Users/max', '/Users/max'), '~');
    assert.strictEqual(shortCwd('/etc', '/Users/max'), '/etc');
  });

  await test('git segment is a string and is safe outside a repo', () => {
    const { gitSegment } = require('../src/prompt');
    assert.strictEqual(typeof gitSegment(process.cwd()), 'string');
    assert.strictEqual(gitSegment('/'), '');
  });

  // --- rendering -----------------------------------------------------------

  await test('renders the prompt and buffer to the terminal', () => {
    const { output } = drive(keysFor('ls'));
    assert.ok(ansi.strip(output.data).includes('% ls'), `got ${JSON.stringify(ansi.strip(output.data))}`);
  });

  await test('right prompt is drawn when it fits and dropped when it does not', () => {
    const shell = new Shell({ output: () => {}, error: () => {} });
    const mk = (columns) => {
      const input = new FakeInput();
      const out = new FakeOutput(columns);
      const ed = new LineEditor({ input, output: out, shell, highlight: (s) => s, complete: completions, history: [] });
      ed.read('% ', 'RIGHT');
      return out.data;
    };
    assert.ok(mk(80).includes('RIGHT'), 'expected the right prompt on a wide terminal');
    assert.ok(!mk(8).includes('RIGHT'), 'expected no right prompt on a narrow terminal');
  });

  if (failures) {
    console.error(`\n${failures} interactive test(s) failed`);
    process.exit(1);
  }
  console.log('\nall interactive tests passed');
}

main();
