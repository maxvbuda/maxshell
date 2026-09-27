'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { History, fuzzyMatch, ago } = require('../src/history');
const { editDistance, suggestCommand, suggestLine } = require('../src/suggest');
const { DirDB, pathMatches } = require('../src/jump');
const { statusLine, shouldNotify, formatDuration } = require('../src/alerts');
const { LineEditor } = require('../src/lineeditor');
const { Shell } = require('../src/interpreter');
const ansi = require('../src/ansi');

let failures = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failures++;
      console.error(`not ok - ${name}\n  ${e.message}`);
    }
  };
  pending.push(run);
}

const scratch = [];
process.on('exit', () => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mxfeat-')));
  scratch.push(d);
  return d;
}

ansi.setEnabled(false);
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const H = 3600e3;

// --- history ----------------------------------------------------------------

function sampleHistory() {
  const h = new History();
  h.add('git push origin main', '/p/maxshell', NOW - 2 * H);
  h.add('git pull --rebase', '/p/maxshell', NOW - 30 * H);
  h.add('git push -u origin feature', '/p/cooking', NOW - 80 * H);
  h.add('gh pr create --push', '/p/maxshell', NOW - 130 * H);
  h.add('ls -la', '/p/maxshell', NOW - 1000);
  return h;
}

test('history search matches words in any order', () => {
  const h = sampleHistory();
  assert.deepStrictEqual(h.search('push git', { now: NOW }).map((r) => r.cmd).sort(),
    ['git push -u origin feature', 'git push origin main']);
});

test('history search favours this folder and recent use', () => {
  const h = sampleHistory();
  const rows = h.search('push origin', { cwd: '/p/maxshell', now: NOW });
  assert.strictEqual(rows[0].cmd, 'git push origin main');
  assert.strictEqual(rows[0].here, true);
  const there = h.search('push origin', { cwd: '/p/cooking', now: NOW });
  assert.ok(there.find((r) => r.cmd === 'git push -u origin feature').here);
});

test('skipped letters still match, as a last resort', () => {
  const m = fuzzyMatch('git push origin', ['gpo']);
  assert.ok(m, 'gpo matches as a subsequence');
  assert.ok(fuzzyMatch('git push origin', ['push']).score > m.score, 'real substrings score higher');
  assert.strictEqual(fuzzyMatch('ls', ['xyz']), null);
});

test('an empty search lists the most recent commands first, once each', () => {
  const h = sampleHistory();
  h.add('ls -la', '/p/other', NOW);
  const rows = h.search('', { now: NOW });
  assert.strictEqual(rows[0].cmd, 'ls -la');
  assert.strictEqual(rows.filter((r) => r.cmd === 'ls -la').length, 1);
  assert.strictEqual(rows[0].count, 2);
});

test('history files round-trip, and old plain lines still load', () => {
  const dir = tmp();
  const file = path.join(dir, 'h');
  fs.writeFileSync(file, 'old style command\n');
  const h = new History().load(file);
  h.add('new one', '/x', NOW);
  h.save(file);
  const back = new History().load(file);
  assert.deepStrictEqual(back.entries, [
    { ts: 0, cwd: null, cmd: 'old style command' },
    { ts: NOW, cwd: '/x', cmd: 'new one' },
  ]);
});

test('multi-line commands survive the history file whole', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxhist-')), 'h');
  const h = new History();
  h.add('for x in a b\ndo\n  echo $x\ndone', '/tmp', 1790000000000);
  h.add('echo one', '/tmp', 1790000000001);
  h.save(file);
  const back = new History().load(file);
  assert.deepStrictEqual(back.commands(), ['for x in a b\ndo\n  echo $x\ndone', 'echo one']);
});

test('repeating the last command in the same folder is not stored twice', () => {
  const h = new History();
  assert.strictEqual(h.add('ls', '/a', 1), true);
  assert.strictEqual(h.add('ls', '/a', 2), false);
  assert.strictEqual(h.add('ls', '/b', 3), true);
  assert.strictEqual(h.entries.length, 2);
});

test('relative times', () => {
  assert.strictEqual(ago(NOW - 5000, NOW), 'just now');
  assert.strictEqual(ago(NOW - 5 * 60e3, NOW), '5m ago');
  assert.strictEqual(ago(NOW - 2 * H, NOW), '2h ago');
  assert.strictEqual(ago(NOW - 72 * H, NOW), '3d ago');
  assert.strictEqual(ago(NOW - 30 * 24 * H, NOW), '4w ago');
});

// --- did you mean -------------------------------------------------------------

const plainShell = () => ({ env: process.env, funcs: new Map(), aliases: new Map() });

test('edit distance treats a swap of neighbours as one mistake', () => {
  assert.strictEqual(editDistance('gti', 'git'), 1);
  assert.strictEqual(editDistance('stauts', 'status'), 1);
  assert.strictEqual(editDistance('kitten', 'sitting'), 3);
});

test('mistyped commands get a suggestion; nonsense does not', () => {
  const sh = plainShell();
  assert.strictEqual(suggestCommand('gti', sh), 'git');
  assert.strictEqual(suggestCommand('sl', sh), 'ls');
  assert.strictEqual(suggestCommand('pyhton3', sh), 'python3');
  assert.strictEqual(suggestCommand('qwzxvb', sh), null);
});

test('whole lines are corrected, subcommands included', () => {
  const sh = plainShell();
  assert.strictEqual(suggestLine('gti stauts', sh), 'git status');
  assert.strictEqual(suggestLine('git comit -m "x"', sh), 'git commit -m "x"');
  assert.strictEqual(suggestLine('npm isntall react', sh), 'npm install react');
  assert.strictEqual(suggestLine('git status', sh), null, 'nothing to fix');
});

test('the shell says did you mean, and remembers the miss', () => {
  const errors = [];
  const sh = new Shell({ output: () => {}, error: (l) => errors.push(l) });
  const status = sh.run('gti --version');
  assert.strictEqual(status, 127);
  assert.match(errors.join('\n'), /command not found: gti — did you mean git\?/);
  assert.deepStrictEqual(sh.lastNotFound, { name: 'gti', guess: 'git' });
});

// --- j, back and forward ---------------------------------------------------------

test('j matches words in order, the last one in the folder name', () => {
  assert.strictEqual(pathMatches('/users/m/maxshell/src', ['max', 'sr']), true);
  assert.strictEqual(pathMatches('/users/m/maxshell/src', ['src', 'max']), false);
  assert.strictEqual(pathMatches('/users/m/maxshell/src', ['max']), false, 'last word must be in the final folder');
});

test('j prefers folders you visit often and recently', () => {
  const db = new DirDB(path.join(tmp(), 'dirs'));
  for (let i = 0; i < 5; i++) db.visit('/u/cooking', NOW - 2 * H);
  db.visit('/u/cookies', NOW - 200 * H);
  const q = (w, opts = {}) => db.query(w, { now: NOW, exists: () => true, ...opts }).map((h) => h.path);
  assert.strictEqual(q(['cook'])[0], '/u/cooking');
  for (let i = 0; i < 30; i++) db.visit('/u/cookies', NOW - 60e3);
  assert.strictEqual(q(['cook'])[0], '/u/cookies', 'heavy recent use wins');
  assert.strictEqual(q(['cook'], { cwd: '/u/cookies' })[0], '/u/cooking', 'never jumps to where you already are');
});

test('j forgets folders that no longer exist', () => {
  const db = new DirDB(path.join(tmp(), 'dirs'));
  db.visit('/gone/away', NOW);
  assert.deepStrictEqual(db.query(['away'], { now: NOW, exists: () => false }), []);
  assert.strictEqual(db.dirs.has('/gone/away'), false);
});

test('the frecency file round-trips', () => {
  const file = path.join(tmp(), 'dirs');
  const db = new DirDB(file);
  db.visit('/a/b', NOW);
  db.visit('/a/b', NOW);
  db.save();
  const again = new DirDB(file);
  assert.strictEqual(again.dirs.get('/a/b').rank, 2);
});

test('the j builtin jumps, lists, and falls back to real paths', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'projects', 'cooking'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'));
  process.env.MAXSHELL_DIRS_FILE = path.join(root, 'dirs');
  const db = new DirDB();
  db.visit(path.join(root, 'projects', 'cooking'));
  db.save();

  const lines = [];
  const errors = [];
  const sh = new Shell({ output: (l) => lines.push(l), error: (l) => errors.push(l), cwd: root });
  sh.run('j cook');
  assert.strictEqual(sh.cwd, path.join(root, 'projects', 'cooking'));
  sh.run(`j ${path.join(root, 'other')}`);
  assert.strictEqual(sh.cwd, path.join(root, 'other'), 'a real path works like cd');
  sh.run('j -l cook');
  assert.match(lines.join('\n'), /projects\/cooking/);
  assert.strictEqual(sh.run('j nothingmatchesthis'), 1);
  assert.match(errors.join('\n'), /no folder you've visited matches/);
  delete process.env.MAXSHELL_DIRS_FILE;
});

test('back and forward walk the folder history like a browser', () => {
  const root = tmp();
  for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, d));
  const sh = new Shell({ output: () => {}, error: () => {}, cwd: root });
  sh.run(`cd ${root}/a; cd ${root}/b; cd ${root}/c`);
  sh.run('back');
  assert.strictEqual(sh.cwd, path.join(root, 'b'));
  sh.run('back 2');
  assert.strictEqual(sh.cwd, root);
  sh.run('forward');
  assert.strictEqual(sh.cwd, path.join(root, 'a'));
  sh.run(`cd ${root}/c`);
  assert.strictEqual(sh.run('forward'), 1, 'a new cd clears the forward history');
});

// --- alerts ------------------------------------------------------------------

test('status lines appear only when a command was slow or failed', () => {
  assert.strictEqual(statusLine(0, 200), null);
  assert.deepStrictEqual(statusLine(0, 42300), { ok: true, text: '✓ 42.3s' });
  assert.deepStrictEqual(statusLine(1, 50), { ok: false, text: '✗ exit 1' });
  assert.deepStrictEqual(statusLine(2, 3200), { ok: false, text: '✗ exit 2 · 3.2s' });
  assert.deepStrictEqual(statusLine(130, 9000), { ok: false, text: '✗ interrupted' });
  assert.strictEqual(statusLine(127, 10), null, 'command-not-found has its own message');
});

test('notifications only when slow and you are in another app', () => {
  assert.strictEqual(shouldNotify(12e3, 10e3, 'Safari'), true);
  assert.strictEqual(shouldNotify(12e3, 10e3, 'Terminal'), false);
  assert.strictEqual(shouldNotify(12e3, 10e3, 'iTerm2'), false);
  assert.strictEqual(shouldNotify(3e3, 10e3, 'Safari'), false);
  assert.strictEqual(shouldNotify(12e3, 10e3, null), true, 'unknown front app: notify');
});

test('durations read naturally', () => {
  assert.strictEqual(formatDuration(900), '0.9s');
  assert.strictEqual(formatDuration(192000), '3m 12s');
  assert.strictEqual(formatDuration(3840000), '1h 4m');
});

// --- the line editor: Ctrl-R and the offered fix ---------------------------------

class FakeInput extends EventEmitter { setRawMode() {} resume() {} pause() {} }
const fakeOut = () => ({ columns: 100, rows: 30, data: '', write(s) { this.data += s; } });

function editor(opts = {}) {
  const input = new FakeInput();
  const output = fakeOut();
  const h = sampleHistory();
  const ed = new LineEditor({
    input, output, shell: new Shell({ output: () => {}, error: () => {} }),
    history: h.commands(),
    searchHistory: (q) => h.search(q, { cwd: '/p/maxshell', now: NOW }),
  });
  const promise = ed.read('% ', '', opts);
  const key = (name, extra = {}) => input.emit('keypress', extra.str || '', { name, ...extra });
  const type = (text) => { for (const ch of text) input.emit('keypress', ch, { name: ch }); };
  return { ed, promise, key, type, output };
}

test('Ctrl-R finds a command and Enter runs it', async () => {
  const { promise, key, type } = editor();
  key('r', { ctrl: true });
  type('pull');
  key('return');
  assert.deepStrictEqual(await promise, { line: 'git pull --rebase' });
});

test('in the search, arrows pick among matches and Tab edits instead of running', async () => {
  const { ed, promise, key, type } = editor();
  key('r', { ctrl: true });
  type('push');
  const first = ed.search.rows[0].cmd;
  key('down');
  const second = ed.search.rows[1].cmd;
  assert.notStrictEqual(first, second);
  key('tab');
  assert.strictEqual(ed.search, null);
  assert.strictEqual(ed.buf, second);
  type(' --dry-run');
  key('return');
  assert.deepStrictEqual(await promise, { line: `${second} --dry-run` });
});

test('Escape leaves the search and restores what you had typed', async () => {
  const { ed, promise, key, type } = editor();
  type('echo half');
  key('r', { ctrl: true });
  type('git');
  key('escape');
  assert.strictEqual(ed.buf, 'echo half');
  key('return');
  assert.deepStrictEqual(await promise, { line: 'echo half' });
});

test('the search draws a list and keeps within the terminal width', () => {
  ansi.setEnabled(true);
  const { key, type, output } = editor();
  key('r', { ctrl: true });
  type('git');
  const text = ansi.strip(output.data);
  assert.match(text, /history › git/);
  assert.match(text, /git push origin main/);
  assert.match(text, /maxshell •\s+(\d+[mhdw] ago|just now)/, 'shows the folder, a dot for "here", and when');
  const { textWidth } = require('../src/tui');
  const lastFrame = output.data.split('\r\x1b[J').pop();
  for (const line of ansi.strip(lastFrame).split('\r\n')) {
    assert.ok(textWidth(line.replace(/\r/g, '')) < 100, `line fits: ${JSON.stringify(line)}`);
  }
  ansi.setEnabled(false);
});

test('an offered fix runs with Enter on an empty line', async () => {
  const { promise, key } = editor({ fix: 'git status' });
  key('return');
  assert.deepStrictEqual(await promise, { line: 'git status' });
});

test('typing something else discards the offered fix', async () => {
  const { ed, promise, key, type } = editor({ fix: 'git status' });
  type('ls');
  assert.strictEqual(ed.fix, null);
  key('return');
  assert.deepStrictEqual(await promise, { line: 'ls' });
});

test('→ takes the fix into the line to edit it', async () => {
  const { promise, key, type } = editor({ fix: 'git status' });
  key('right');
  type(' -s');
  key('return');
  assert.deepStrictEqual(await promise, { line: 'git status -s' });
});

test('the fix is shown dimmed with a hint', () => {
  ansi.setEnabled(true);
  const { output } = editor({ fix: 'git status' });
  assert.match(ansi.strip(output.data), /git status {3}⏎ runs it/);
  ansi.setEnabled(false);
});

(async () => {
  for (const run of pending) await run();
  if (failures) {
    console.error(`\n${failures} feature test(s) failed`);
    process.exit(1);
  }
  console.log('\nall feature tests passed');
})();
