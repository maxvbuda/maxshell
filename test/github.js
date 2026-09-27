'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ansi = require('../src/ansi');
const git = require('../src/git');
const gh = require('../src/github');
const { GitUI } = require('../src/gitui');
const { explain } = require('../src/githubview');
const { textWidth } = require('../src/tui');

let failures = 0;
function test(name, fn) {
  try {
    ansi.setEnabled(false);
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok - ${name}\n  ${e.message}`);
  } finally {
    gh.setRunner(null);
    ansi.setEnabled(false);
  }
}

const scratch = [];
process.on('exit', () => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

// --- a fake gh ----------------------------------------------------------------------

const NOW = new Date().toISOString();
const PR = {
  number: 12, title: 'Add login page', state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/12',
  author: { login: 'max' }, headRefName: 'feature-login', baseRefName: 'main', updatedAt: NOW,
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'lint', conclusion: 'SUCCESS' }],
};

// Answers gh commands from canned data and records every call.
function fakeGh(overrides = {}) {
  const calls = [];
  const data = {
    repo: { nameWithOwner: 'o/r', url: 'https://github.com/o/r', defaultBranchRef: { name: 'main' }, isPrivate: true },
    branchPR: null,
    prs: [PR],
    issues: [{ number: 7, title: 'Crash on start', state: 'OPEN', url: 'u7', author: { login: 'sam' }, labels: [{ name: 'bug' }], comments: [{}, {}], updatedAt: NOW }],
    runs: [{ databaseId: 99, displayTitle: 'Add login page', workflowName: 'CI', status: 'completed', conclusion: 'failure', headBranch: 'feature-login', event: 'push', createdAt: NOW, url: 'u99' }],
    ...overrides,
  };
  const ok = (v) => ({ ok: true, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
  gh.setRunner((cwd, args) => {
    calls.push(args);
    const [a, b] = args;
    if (data.fail) return { ok: false, stdout: '', stderr: data.fail };
    if (a === 'repo' && b === 'view') return ok(data.repo);
    if (a === 'pr' && b === 'view' && args[2] === '--json') {
      return data.branchPR ? ok(data.branchPR) : { ok: false, stdout: '', stderr: 'no pull requests found for branch "x"' };
    }
    if (a === 'pr' && b === 'view') return ok({ ...PR, body: 'Adds a page.', additions: 40, deletions: 3, changedFiles: 2, comments: [{ author: { login: 'kim' }, body: 'Looks good' }], reviews: [] });
    if (a === 'pr' && b === 'list') return ok(data.prs);
    if (a === 'issue' && b === 'list') return ok(data.issues);
    if (a === 'run' && b === 'list') return ok(data.runs);
    if (a === 'run' && b === 'view') return ok('✗ feature-login CI · 99\nJOBS\n✗ test in 12s');
    if (a === 'pr' && b === 'create') return ok('https://github.com/o/r/pull/13\n');
    if (a === 'issue' && b === 'create') return ok('https://github.com/o/r/issues/8\n');
    if (a === 'pr' && (b === 'merge' || b === 'checkout')) return ok('');
    return { ok: false, stdout: '', stderr: `unexpected: gh ${args.join(' ')}` };
  });
  return calls;
}

// --- a real repository with a local "origin" ------------------------------------------

function repoWithOrigin() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mxgh-')));
  scratch.push(root);
  const origin = path.join(root, 'origin.git');
  const dir = path.join(root, 'work');
  git.run(root, ['init', '-q', '--bare', origin]);
  fs.mkdirSync(dir);
  git.run(dir, ['init', '-q']);
  git.run(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git.run(dir, ['config', 'user.email', 't@t']);
  git.run(dir, ['config', 'user.name', 'T']);
  git.run(dir, ['config', 'commit.gpgsign', 'false']);
  git.run(dir, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git.run(dir, ['add', '.']);
  git.run(dir, ['commit', '-q', '-m', 'first']);
  git.run(dir, ['push', '-q', '-u', 'origin', 'main']);
  return { dir, origin };
}

function makeUI(dir, cols = 100) {
  const shell = { cwd: dir, env: process.env, options: new Set(), resolve: (f) => path.join(dir, f), writeTo() {} };
  const output = { rows: 24, columns: cols, data: '', write(s) { this.data += s; } };
  const gui = new GitUI({ shell, io: {}, output });
  gui.refresh();
  gui.refreshGitHub(true);
  gui.opened = [];
  gh.openInBrowser = ((orig) => (url) => { gui.opened.push(url); return true; })(gh.openInBrowser);
  return gui;
}
const press = (ui, name, extra = {}) => ui.handleKey({ name, ...extra });
const typeKeys = (ui, text) => { for (const ch of text) ui.handleKey({ name: ch, str: ch, printable: true }); };
const key = (ui, ch) => ui.handleKey({ name: ch, str: ch, printable: true });

// --- summaries -------------------------------------------------------------------

test('check runs collapse to one state and a badge', () => {
  assert.deepStrictEqual(gh.checks([]), { passed: 0, failed: 0, pending: 0, total: 0, state: 'none' });
  assert.strictEqual(gh.checks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]).state, 'failing');
  assert.strictEqual(gh.checks([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]).state, 'pending');
  assert.strictEqual(gh.checksBadge(gh.checks([{ state: 'SUCCESS' }, { state: 'SUCCESS' }])), '✓ 2');
  assert.strictEqual(gh.checksBadge(gh.checks([{ conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }])), '✗ 1/2');
  assert.strictEqual(gh.runBadge({ status: 'in_progress' }), '●');
});

test('no pull request for a branch is not an error', () => {
  fakeGh();
  assert.deepStrictEqual(gh.branchPR('/x'), { data: null });
});

test('gh problems are explained in plain words', () => {
  assert.match(explain('x', true), /brew install gh/);
  assert.match(explain('To get started with GitHub CLI, please run:  gh auth login'), /gh auth login/);
  assert.match(explain('none of the git remotes configured for this repository point to a known GitHub host'), /no GitHub remote/);
});

// --- gitui ----------------------------------------------------------------------------

test('the title bar shows the repo and this branch’s pull request', () => {
  const { dir } = repoWithOrigin();
  fakeGh({ branchPR: PR });
  const ui = makeUI(dir, 120);
  const title = ansi.strip(ui.titleBar());
  assert.match(title, /o\/r · PR #12 ✓ 2/);
});

test('G opens pull requests, issues and runs in tabs', () => {
  const { dir } = repoWithOrigin();
  fakeGh();
  const ui = makeUI(dir);
  key(ui, 'G');
  assert.strictEqual(ui.mode, 'github');
  ui.render();
  let screen = ansi.strip(ui.output.data.split('\x1b[H').pop());
  assert.match(screen, /Pull requests \(1\)/);
  assert.match(screen, /#12\s+✓ 2\s+Add login page/);
  press(ui, 'right');
  ui.output.data = '';
  ui.render();
  screen = ansi.strip(ui.output.data);
  assert.match(screen, /#7\s+Crash on start\s+bug · 2 comments/);
  press(ui, 'right');
  ui.output.data = '';
  ui.render();
  assert.match(ansi.strip(ui.output.data), /✗\s+CI: Add login page/);
  press(ui, 'escape');
  assert.strictEqual(ui.mode, 'list');
});

test('every line of the GitHub screen fits the terminal', () => {
  ansi.setEnabled(true);
  const { dir } = repoWithOrigin();
  fakeGh({ prs: [{ ...PR, title: 'A very long pull request title that keeps going and going and going' }] });
  for (const cols of [60, 100, 160]) {
    const ui = makeUI(dir, cols);
    key(ui, 'G');
    ui.output.data = '';
    ui.render();
    const lines = ansi.strip(ui.output.data.replace(/\x1b\[\d+;\d+H/g, '')).split('\r\n');
    for (const l of lines) assert.ok(textWidth(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')) <= cols, `${cols}: ${l}`);
  }
});

test('Enter shows details; o opens in the browser', () => {
  const { dir } = repoWithOrigin();
  fakeGh();
  const ui = makeUI(dir);
  key(ui, 'G');
  press(ui, 'return');
  assert.strictEqual(ui.mode, 'output');
  assert.ok(ui.view.some((l) => /\+40 −3 in 2 files · review: approved/.test(l)));
  assert.ok(ui.view.includes('Looks good'));
  press(ui, 'escape');
  assert.strictEqual(ui.mode, 'github', 'the pager returns to the GitHub screen');
  key(ui, 'o');
  assert.deepStrictEqual(ui.opened, ['https://github.com/o/r/pull/12']);
});

test('merging needs the word "merge"', () => {
  const { dir } = repoWithOrigin();
  const calls = fakeGh();
  const ui = makeUI(dir);
  key(ui, 'G');
  key(ui, 'm');
  typeKeys(ui, 'y');
  press(ui, 'return');
  assert.ok(!calls.some((c) => c[1] === 'merge'), 'y is not enough');
  assert.strictEqual(ui.mode, 'github');
  key(ui, 'm');
  typeKeys(ui, 'merge');
  press(ui, 'return');
  assert.deepStrictEqual(calls.find((c) => c[1] === 'merge'), ['pr', 'merge', '12', '--squash', '--delete-branch']);
});

test('c checks out a pull request after asking', () => {
  const { dir } = repoWithOrigin();
  const calls = fakeGh();
  const ui = makeUI(dir);
  key(ui, 'G');
  key(ui, 'c');
  typeKeys(ui, 'y');
  press(ui, 'return');
  assert.ok(calls.some((c) => c[0] === 'pr' && c[1] === 'checkout' && c[2] === '12'));
});

test('n on the Issues tab creates an issue', () => {
  const { dir } = repoWithOrigin();
  const calls = fakeGh();
  const ui = makeUI(dir);
  key(ui, 'G');
  press(ui, 'right');
  key(ui, 'n');
  typeKeys(ui, 'Button is misaligned');
  press(ui, 'return');
  assert.ok(calls.some((c) => c[0] === 'issue' && c[1] === 'create' && c.includes('Button is misaligned')));
  assert.match(ui.message, /issues\/8/);
});

test('P refuses on the default branch', () => {
  const { dir } = repoWithOrigin();
  fakeGh();
  const ui = makeUI(dir);
  key(ui, 'P');
  assert.match(ui.message, /you're on main — create a branch first/);
});

test('P publishes a new branch, then opens a pull request titled from the last commit', () => {
  const { dir, origin } = repoWithOrigin();
  git.run(dir, ['switch', '-q', '-c', 'feature-x']);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git.run(dir, ['add', '.']);
  git.run(dir, ['commit', '-q', '-m', 'Add b']);
  const calls = fakeGh();
  const ui = makeUI(dir);

  key(ui, 'P');
  assert.match(ui.prompt.label, /publish feature-x to origin\?/);
  typeKeys(ui, 'y');
  press(ui, 'return');
  assert.ok(git.run(origin, ['rev-parse', '--verify', 'feature-x']).ok, 'the branch reached origin');
  assert.match(ui.prompt.label, /Pull request title \(into main\)/);
  assert.strictEqual(ui.prompt.value, 'Add b', 'the title defaults to the last commit');
  press(ui, 'return');
  const create = calls.find((c) => c[1] === 'create');
  assert.deepStrictEqual(create.slice(0, 5), ['pr', 'create', '--title', 'Add b', '--body']);
  assert.ok(create.includes('--base') && create.includes('main'));
  assert.match(ui.message, /opened https:\/\/github.com\/o\/r\/pull\/13/);
});

test('P says so when the branch already has a pull request', () => {
  const { dir } = repoWithOrigin();
  git.run(dir, ['switch', '-q', '-c', 'feature-login']);
  fakeGh({ branchPR: PR });
  const ui = makeUI(dir);
  key(ui, 'P');
  assert.match(ui.message, /#12 is already open/);
});

test('O opens this branch’s pull request, or the repo', () => {
  const { dir } = repoWithOrigin();
  fakeGh();
  const noPr = makeUI(dir);
  key(noPr, 'O');
  assert.deepStrictEqual(noPr.opened.slice(-1), ['https://github.com/o/r']);
  fakeGh({ branchPR: PR });
  const withPr = makeUI(dir);
  key(withPr, 'O');
  assert.deepStrictEqual(withPr.opened.slice(-1), ['https://github.com/o/r/pull/12']);
});

test('without gh or a login, gitui still works and says why GitHub is unavailable', () => {
  const { dir } = repoWithOrigin();
  fakeGh({ fail: 'To get started with GitHub CLI, please run:  gh auth login' });
  const ui = makeUI(dir);
  assert.match(ui.github.error, /gh auth login/);
  key(ui, 'G');
  assert.strictEqual(ui.mode, 'list');
  assert.match(ui.message, /gh auth login/);
  assert.doesNotMatch(ansi.strip(ui.titleBar()), /PR/);
});

test('^T publishes a branch that has never been pushed', () => {
  const { dir, origin } = repoWithOrigin();
  git.run(dir, ['switch', '-q', '-c', 'lonely']);
  fakeGh();
  const ui = makeUI(dir);
  press(ui, 't', { ctrl: true });
  assert.match(ui.prompt.label, /origin \(publishing lonely\)/);
  typeKeys(ui, 'y');
  press(ui, 'return');
  assert.ok(git.run(origin, ['rev-parse', '--verify', 'lonely']).ok);
});

if (failures) {
  console.error(`\n${failures} github test(s) failed`);
  process.exit(1);
}
console.log('\nall github tests passed');
