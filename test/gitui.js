'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const git = require('../src/git');
const { GitUI } = require('../src/gitui');

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

// --- a throwaway repository to act on ---------------------------------------

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxgit-'));
  git.run(dir, ['init', '-q']);
  git.run(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git.run(dir, ['config', 'user.email', 'test@example.com']);
  git.run(dir, ['config', 'user.name', 'Test']);
  git.run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function write(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
}

function ui(dir) {
  const shell = {
    cwd: dir,
    env: process.env,
    options: new Set(),
    resolve: (f) => (path.isAbsolute(f) ? f : path.join(dir, f)),
    writeTo() {},
  };
  const gui = new GitUI({ shell, io: {}, output: { rows: 24, columns: 80, write() {} } });
  gui.refresh();
  return gui;
}

// --- parsing ----------------------------------------------------------------

test('porcelain v2 status is parsed', () => {
  const sample = [
    '# branch.oid abc123',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb staged-only.txt',
    '1 .M N... 100644 100644 100644 aaa bbb worktree-only.txt',
    '1 MM N... 100644 100644 100644 aaa bbb both.txt',
    '? new file.txt',
    '! ignored.txt',
  ].join('\n');

  const s = git.parseStatus(sample);
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.upstream, 'origin/main');
  assert.strictEqual(s.ahead, 2);
  assert.strictEqual(s.behind, 1);
  assert.deepStrictEqual(s.staged.map((e) => e.path), ['staged-only.txt', 'both.txt']);
  assert.deepStrictEqual(s.unstaged.map((e) => e.path), ['worktree-only.txt', 'both.txt']);
  assert.deepStrictEqual(s.untracked.map((e) => e.path), ['new file.txt'], 'paths may contain spaces');
  assert.strictEqual(s.staged.find((e) => e.path === 'both.txt').code, 'M');
});

test('a rename keeps both the new and original path', () => {
  const line = '2 R. N... 100644 100644 100644 aaa bbb R100 after.txt\tbefore.txt';
  const s = git.parseStatus(line);
  assert.strictEqual(s.staged[0].path, 'after.txt');
  assert.strictEqual(s.staged[0].orig, 'before.txt');
  assert.strictEqual(s.staged[0].code, 'R');
});

test('status on a non-repository reports an error rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxnogit-'));
  const s = git.status(dir);
  assert.ok(s.error, 'expected an error message');
  assert.deepStrictEqual(s.staged, []);
  assert.strictEqual(git.isRepo(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- acting on a real repository --------------------------------------------

test('a new file shows as untracked, then staged, then committed', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'hello\n');

  let s = git.status(dir);
  assert.deepStrictEqual(s.untracked.map((e) => e.path), ['a.txt']);

  git.stage(dir, 'a.txt');
  s = git.status(dir);
  assert.deepStrictEqual(s.staged.map((e) => e.path), ['a.txt']);
  assert.strictEqual(s.untracked.length, 0);

  const res = git.commit(dir, 'first');
  assert.ok(res.ok, `commit failed: ${res.stderr}`);
  s = git.status(dir);
  assert.strictEqual(s.staged.length, 0);
  assert.match(git.log(dir, 1), /first/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('unstaging puts a file back in the worktree list', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\n');
  git.stage(dir, 'a.txt');
  git.commit(dir, 'first');

  write(dir, 'a.txt', 'two\n');
  git.stage(dir, 'a.txt');
  assert.strictEqual(git.status(dir).staged.length, 1);

  git.unstage(dir, 'a.txt');
  const s = git.status(dir);
  assert.strictEqual(s.staged.length, 0);
  assert.deepStrictEqual(s.unstaged.map((e) => e.path), ['a.txt']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('discard restores a tracked file', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'original\n');
  git.stage(dir, 'a.txt');
  git.commit(dir, 'first');

  write(dir, 'a.txt', 'ruined\n');
  git.discard(dir, 'a.txt');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'original\n');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('diffs are produced for staged, unstaged and untracked files', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\n');
  git.stage(dir, 'a.txt');
  git.commit(dir, 'first');

  write(dir, 'a.txt', 'two\n');
  const unstaged = git.diff(dir, { path: 'a.txt' }, 'unstaged');
  assert.match(unstaged, /-one/);
  assert.match(unstaged, /\+two/);

  git.stage(dir, 'a.txt');
  assert.match(git.diff(dir, { path: 'a.txt' }, 'staged'), /\+two/);

  write(dir, 'b.txt', 'brand new\n');
  assert.match(git.diff(dir, { path: 'b.txt' }, 'untracked'), /\+brand new/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the browser model ------------------------------------------------------

test('rows are grouped under section headers', () => {
  const dir = tempRepo();
  write(dir, 'staged.txt', 'a\n');
  git.stage(dir, 'staged.txt');
  write(dir, 'loose.txt', 'b\n');

  const gui = ui(dir);
  const headers = gui.rows.filter((r) => r.kind === 'header').map((r) => r.text);
  assert.deepStrictEqual(headers, ['Staged (1)', 'Untracked (1)']);
  assert.ok(gui.selectedEntry(), 'something should be selected');
  assert.strictEqual(gui.rows[gui.sel].kind, 'entry', 'a header is never selected');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('moving skips over the headers', () => {
  const dir = tempRepo();
  write(dir, 'one.txt', 'a\n');
  git.stage(dir, 'one.txt');
  write(dir, 'two.txt', 'b\n');

  const gui = ui(dir);
  const seen = [gui.selectedEntry().entry.path];
  while (gui.moveSel(1)) seen.push(gui.selectedEntry().entry.path);
  assert.deepStrictEqual(seen, ['one.txt', 'two.txt']);

  while (gui.moveSel(-1)) { /* walk back */ }
  assert.strictEqual(gui.selectedEntry().entry.path, 'one.txt');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('space stages the selected file and unstages it again', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');

  const gui = ui(dir);
  assert.strictEqual(gui.selectedEntry().section, 'untracked');

  gui.toggleStage();
  assert.strictEqual(git.status(dir).staged.length, 1);
  assert.strictEqual(gui.selectedEntry().section, 'staged', 'selection follows the file');

  gui.toggleStage();
  assert.strictEqual(git.status(dir).staged.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('stage all and unstage all before the first commit', () => {
  // An unborn HEAD has nothing to reset against, so this path differs.
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');
  write(dir, 'b.txt', 'y\n');
  assert.strictEqual(git.hasCommits(dir), false);

  const gui = ui(dir);
  gui.stageAll();
  assert.strictEqual(gui.status.staged.length, 2);
  gui.unstageAll();
  assert.strictEqual(gui.status.staged.length, 0);
  assert.strictEqual(gui.status.untracked.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('stage all and unstage all once there are commits', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');
  git.stage(dir, 'a.txt');
  git.commit(dir, 'first');
  assert.strictEqual(git.hasCommits(dir), true);

  write(dir, 'a.txt', 'changed\n');
  write(dir, 'b.txt', 'y\n');

  const gui = ui(dir);
  gui.stageAll();
  assert.strictEqual(gui.status.staged.length, 2);
  gui.unstageAll();
  assert.strictEqual(gui.status.staged.length, 0);
  assert.strictEqual(gui.status.unstaged.length, 1, 'a.txt is modified again');
  assert.strictEqual(gui.status.untracked.length, 1, 'b.txt is untracked again');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('unstaging a single file works before the first commit too', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');
  const gui = ui(dir);
  gui.toggleStage();
  assert.strictEqual(gui.status.staged.length, 1);
  gui.toggleStage();
  assert.strictEqual(gui.status.staged.length, 0);
  assert.strictEqual(gui.status.untracked.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the diff pane follows the selection', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\n');
  git.stage(dir, 'a.txt');
  git.commit(dir, 'first');
  write(dir, 'a.txt', 'changed\n');

  const gui = ui(dir);
  assert.ok(gui.diffLines.some((l) => l.includes('+changed')), 'diff should show the change');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the signature changes when the repository does', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');
  const gui = ui(dir);
  const before = gui.signature();

  write(dir, 'b.txt', 'y\n');
  gui.refresh();
  assert.notStrictEqual(gui.signature(), before);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('committing needs something staged, and a message', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');
  const gui = ui(dir);

  gui.askCommit();
  assert.strictEqual(gui.mode, 'list', 'nothing staged, so no prompt');
  assert.match(gui.message, /nothing staged/);

  gui.toggleStage();
  gui.askCommit();
  assert.strictEqual(gui.mode, 'prompt');
  gui.handleKey({ name: 'return' });
  assert.match(gui.message, /cancelled/, 'an empty message cancels');
  assert.strictEqual(git.status(dir).staged.length, 1, 'still staged');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('discarding an untracked file demands an explicit yes', () => {
  const dir = tempRepo();
  write(dir, 'junk.txt', 'x\n');
  const gui = ui(dir);

  gui.askDiscard();
  assert.strictEqual(gui.mode, 'prompt');
  assert.match(gui.prompt.label, /Type yes/);

  // Anything other than "yes" leaves the file alone.
  for (const ch of 'no') gui.handleKey({ name: ch, printable: true, str: ch });
  gui.handleKey({ name: 'return' });
  assert.ok(fs.existsSync(path.join(dir, 'junk.txt')), 'file should survive');

  gui.askDiscard();
  for (const ch of 'yes') gui.handleKey({ name: ch, printable: true, str: ch });
  gui.handleKey({ name: 'return' });
  assert.ok(!fs.existsSync(path.join(dir, 'junk.txt')), 'file should be gone');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a staged file cannot be discarded until it is unstaged', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');
  const gui = ui(dir);
  gui.toggleStage();

  gui.askDiscard();
  assert.strictEqual(gui.mode, 'list', 'no prompt for a staged file');
  assert.match(gui.message, /unstage it first/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('q and ^X leave the browser', () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'x\n');

  const byLetter = ui(dir);
  byLetter.handleKey({ name: 'q', printable: true, str: 'q' });
  assert.strictEqual(byLetter.done, true);

  const byCtrl = ui(dir);
  byCtrl.handleKey({ name: 'x', ctrl: true });
  assert.strictEqual(byCtrl.done, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

if (failures) {
  console.error(`\n${failures} gitui test(s) failed`);
  process.exit(1);
}
console.log('\nall gitui tests passed');
