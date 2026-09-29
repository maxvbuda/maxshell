'use strict';

// The command palette, the picker, explain, the dashboard, snippets and
// bookmarks.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mxpal-'));
process.env.MAXSHELL_SNIPPETS_FILE = path.join(scratch, 'snippets');
process.env.MAXSHELL_MARKS_FILE = path.join(scratch, 'marks');
process.env.MAXSHELL_DIRS_FILE = path.join(scratch, 'dirs');
process.env.MAXSHELL_HISTORY_FILE = path.join(scratch, 'history');

const ansi = require('../src/ansi');
const { Shell } = require('../src/interpreter');
const { Picker } = require('../src/picker');
const { paletteItems } = require('../src/palette');
const { explainRows, explain, flagHelp } = require('../src/explain');
const { DashModel, DashScreen } = require('../src/dash');
const { Store, suggestName } = require('../src/snippets');
const { textWidth } = require('../src/tui');

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

function shellIn(dir) {
  const lines = [];
  const sh = new Shell({ output: (l) => lines.push(l), error: () => {} });
  sh.lines = lines;
  sh.run(`cd ${dir}`);
  return sh;
}

const repo = path.resolve(__dirname, '..');
const fitsIn = (lines, cols) => lines.every((l) => textWidth(ansi.strip(l)) <= cols);

// --- the picker ----------------------------------------------------------------

test('the picker filters by every word, in any order', () => {
  const p = new Picker([
    { label: 'git push', desc: 'upload commits', group: 'git' },
    { label: 'theme nord', desc: 'arctic blues', group: 'themes' },
    { label: 'npm run test', desc: 'node test/run.js', group: 'npm' },
  ]);
  p.type('blue nord');
  assert.deepStrictEqual(p.rows.map((r) => r.item.label), ['theme nord']);
  p.handleKey({ name: 'u', ctrl: true });
  p.backspace();
  p.type('upl');
  assert.strictEqual(p.selected.label, 'git push');
  assert.strictEqual(p.handleKey({ name: 'return' }), true);
  assert.strictEqual(p.chosen.label, 'git push');
});

test('the picker moves, cancels, and draws within the width', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ label: `item ${i} 🎨`, desc: 'x'.repeat(200), icon: '🔖', group: 'g' }));
  const p = new Picker(items, { title: 'test' });
  p.handleKey({ name: 'down' });
  p.handleKey({ name: 'pagedown' });
  assert.strictEqual(p.index, 11);
  ansi.setEnabled(true);
  for (const cols of [40, 80, 120]) {
    const lines = p.render(cols, 20);
    assert.strictEqual(lines.length, 20);
    assert.ok(fitsIn(lines, cols), `${cols} cols`);
  }
  ansi.setEnabled(false);
  assert.strictEqual(p.handleKey({ name: 'escape' }), true);
  assert.strictEqual(p.chosen, null);
});

// --- the palette ---------------------------------------------------------------

test('the palette offers tools, this project’s scripts and git, and themes', () => {
  const sh = shellIn(repo);
  const labels = paletteItems(sh).map((i) => i.label);
  for (const want of ['dash', 'files', 'gitui', 'npm run test', 'git status', 'theme nord']) {
    assert.ok(labels.includes(want), `missing ${want}`);
  }
});

test('snippets and bookmarks appear in the palette', () => {
  const sh = shellIn(repo);
  sh.run("snip add deploy 'npm run build && ./ship'\nmark proj");
  const items = paletteItems(sh);
  const snip = items.find((i) => i.label === 'deploy');
  assert.strictEqual(snip.value, 'npm run build && ./ship');
  assert.ok(snip.insert, 'snippets go on the line to edit');
  assert.strictEqual(items.find((i) => i.label === 'proj').value, `cd ${repo}`);
});

// --- snippets and bookmarks ----------------------------------------------------------

test('snip add, save, mv, rm and -l', () => {
  const sh = shellIn(scratch);
  sh.run("snip add greet 'echo hello there'\necho last one\nsnip save again\nsnip mv greet hi\nsnip rm again");
  sh.lines.length = 0;
  sh.run('snip -l');
  assert.deepStrictEqual(sh.lines, ['deploy  npm run build && ./ship', 'hi      echo hello there']);
  sh.run('snip hi');
  assert.strictEqual(sh.prefill, 'echo hello there', 'naming a snippet puts it on the prompt');
  assert.strictEqual(suggestName('git log --oneline -20'), 'git-log');
});

test('the store keeps any text, tabs and newlines included', () => {
  const file = path.join(scratch, 'store');
  new Store(file).set('multi', 'for x in a\tb\ndo echo $x; done');
  assert.strictEqual(new Store(file).get('multi'), 'for x in a\tb\ndo echo $x; done');
});

test('mark and go', () => {
  const sub = fs.mkdtempSync(path.join(scratch, 'place-'));
  const sh = shellIn(sub);
  sh.run('mark there\ncd /\ngo there\npwd\ncd /\ngo the\npwd');
  assert.deepStrictEqual(sh.lines.slice(-2), [sub, sub]);
  sh.run('mark -d there');
  assert.strictEqual(sh.run('go there'), 1);
});

// --- explain -------------------------------------------------------------------

test('explain describes programs, flags, globs, variables, redirects and operators', () => {
  const sh = shellIn(repo);
  const rows = explainRows('grep -rn TODO $HOME src/*.js > out.txt 2>&1 && echo done | wc -l', sh);
  const find = (t) => rows.find((r) => r[0].trim() === t);
  assert.match(find('grep')[1], /\/grep$/);
  assert.ok(find('-r'), 'combined flags are split');
  assert.match(find('$HOME')[1], new RegExp(`→ ${os.homedir()}`));
  assert.match(find('src/*.js')[1], /^matches src\/\w+\.js .*\(\d+ in all\)$/);
  assert.match(find('> out.txt')[1], /replacing it/);
  assert.match(find('2>&1')[1], /errors go where the output goes/);
  assert.match(find('&&')[1], /if that worked/);
  assert.match(find('|')[1], /output into/);
  assert.strictEqual(find('echo')[2], 'builtin');
});

test('explain never runs command substitutions, and handles the unknown', () => {
  const sh = shellIn(scratch);
  const marker = path.join(scratch, 'ran');
  const rows = explainRows(`echo $(touch ${marker}) ; nosuchcmd-xyz`, sh);
  assert.ok(!fs.existsSync(marker));
  assert.ok(rows.some((r) => /not run now/.test(r[1])));
  assert.ok(rows.some((r) => /not found/.test(r[1])));
  assert.match(explainRows('if true; then', sh)[0][1], /can't read this yet/);
});

test('flag descriptions come from the manual', () => {
  const page = '     -a      Include entries whose names begin with a dot.\n     -l      (The lowercase letter “ell”.)  List in the long format.\n' +
    '     -m <msg>, --message=<msg>\n           Use <msg> as the commit message.\n';
  assert.strictEqual(flagHelp(page, '-a'), 'Include entries whose names begin with a dot.');
  assert.strictEqual(flagHelp(page, '-m'), 'Use <msg> as the commit message.');
  assert.strictEqual(flagHelp(page, '-z'), null);
});

test('the explanation fits the terminal', () => {
  const sh = shellIn(repo);
  ansi.setEnabled(true);
  assert.ok(fitsIn(explain('tar -czf archive-with-a-long-name.tgz src/*.js README.md', sh, 50), 50));
  ansi.setEnabled(false);
});

// --- the dashboard --------------------------------------------------------------

test('the dashboard gathers git, machine, jobs and recent commands', () => {
  const sh = shellIn(repo);
  const m = new DashModel(sh, { sample: false });
  m.refresh();
  assert.ok(m.git && m.git.branch, 'git branch');
  assert.ok(m.cores.length > 0);
  assert.ok(m.mem.used > 0 && m.mem.used <= m.mem.total);
  assert.ok(Array.isArray(m.jobs) && Array.isArray(m.recent));
});

test('the dashboard draws in one or two columns, always within the width', () => {
  const sh = shellIn(repo);
  const m = new DashModel(sh, { sample: false });
  m.refresh();
  const screen = new DashScreen(m);
  ansi.setEnabled(true);
  for (const [cols, rows] of [[60, 30], [100, 30], [160, 40]]) {
    const lines = screen.render(cols, rows);
    assert.strictEqual(lines.length, rows);
    assert.ok(fitsIn(lines, cols), `${cols} cols`);
    assert.ok(lines.some((l) => ansi.strip(l).includes('Project')));
  }
  ansi.setEnabled(false);
  screen.handleKey({ name: 'g' });
  assert.strictEqual(screen.action, 'gitui');
  assert.ok(screen.done);
});

// --- cleanup -------------------------------------------------------------------

test('cleanup groups an app’s helpers, skips the system and other users, and ranks', () => {
  const { hogs } = require('../src/cleanup');
  const MB = 1024 * 1024;
  const procs = [
    { pid: 1, name: 'Google Chrome', user: 'me', rss: 800 * MB, cpu: 10, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { pid: 2, name: 'Google Chrome Helper', user: 'me', rss: 900 * MB, cpu: 30, command: '/Applications/Google Chrome.app/Contents/Frameworks/x/Helper' },
    { pid: 3, name: 'node', user: 'me', rss: 1200 * MB, cpu: 5, command: 'node server.js' },
    { pid: 4, name: 'WindowServer', user: 'me', rss: 3000 * MB, cpu: 50, command: '/System/WindowServer' },
    { pid: 5, name: 'mysqld', user: '_mysql', rss: 2000 * MB, cpu: 80, command: 'mysqld' },
    { pid: 6, name: 'tiny', user: 'me', rss: 1 * MB, cpu: 0, command: 'tiny' },
    { pid: 7, name: 'node', user: 'me', rss: 5000 * MB, cpu: 90, command: 'node maxshell' },
  ];
  const byMem = hogs(procs, { kind: 'r', user: 'me', exclude: new Set([7]) });
  assert.deepStrictEqual(byMem.map((g) => g.name), ['Google Chrome', 'node']);
  assert.deepStrictEqual(byMem[0].pids, [1, 2]);
  const byCpu = hogs(procs, { kind: 'c', user: 'me', exclude: new Set([7]) });
  assert.strictEqual(byCpu[0].name, 'Google Chrome');
  assert.strictEqual(byCpu[0].cpu, 40);
});

test('cleanup finds windowless apps, leftover helpers and orphaned stopped processes', () => {
  const { unnecessary } = require('../src/cleanup');
  const MB = 1024 * 1024;
  const P = (pid, name, command, extra = {}) => ({ pid, ppid: 100, name, user: 'me', rss: 100 * MB, cpu: 1, command, ...extra });
  const procs = [
    P(10, 'Slack', '/Applications/Slack.app/Contents/MacOS/Slack'),
    P(11, 'Slack Helper', '/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper'),
    P(20, 'Notes', '/System/Applications/Notes.app/Contents/MacOS/Notes'),
    P(30, 'Music', '/System/Applications/Music.app/Contents/MacOS/Music'),
    P(40, 'Chrome Helper', '/Applications/Google Chrome.app/Contents/Frameworks/x/Helper', { ppid: 1 }),
    P(41, 'Chrome Helper', '/Applications/Google Chrome.app/Contents/Frameworks/x/Helper', { ppid: 1 }),
    P(50, 'Login', '/Applications/1Password.app/Contents/Library/LoginItems/1Password Launcher'),
    P(55, 'sys', '/System/Library/CoreServices/Setup Assistant.app/Contents/Resources/helper'),
    P(60, 'vim', 'vim notes.txt', { ppid: 1 }),
    P(70, 'vim', 'vim other.txt'),
    P(80, 'Terminal', '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'),
  ];
  const found = unnecessary(procs, {
    user: 'me',
    apps: [{ name: 'Slack', pid: 10 }, { name: 'Notes', pid: 20 }, { name: 'Music', pid: 30 }, { name: 'Terminal', pid: 80 }],
    windows: { 20: 2 },
    states: [{ pid: 60, ppid: 1, stopped: true }, { pid: 70, ppid: 100, stopped: true }],
    exclude: new Set([80]),
    keep: new Set(['Music']),
  });
  const names = found.map((g) => `${g.name}: ${g.reason}`);
  assert.deepStrictEqual(names, [
    'Slack: open with no windows',
    'Google Chrome helpers: Google Chrome isn\'t running',
    'vim: suspended, and its shell has closed',
  ]);
  assert.deepStrictEqual(found[0].pids, [10, 11], 'the app goes with its helpers');
  assert.strictEqual(found[0].app, 'Slack', 'apps get a normal Quit');
});

test('cleanup -n only reports; --keep remembers apps to leave alone', () => {
  process.env.MAXSHELL_CLEANUP_KEEP_FILE = path.join(scratch, 'keep');
  const sh = shellIn(scratch);
  sh.run('cleanup --keep Slack');
  sh.lines.length = 0;
  sh.run('cleanup --keep');
  assert.ok(sh.lines.includes('Slack') && sh.lines.includes('Music'));
  assert.strictEqual(sh.run('cleanup -n < /dev/null'), 0);
  assert.ok(sh.lines.some((l) => /Unnecessary|nothing unnecessary/.test(ansi.strip(l))));
});

test('cleanup reads choices like 1 3, 2-4 and all', () => {
  const { parseChoice } = require('../src/cleanup');
  assert.deepStrictEqual(parseChoice('1 3', 5), [0, 2]);
  assert.deepStrictEqual(parseChoice('2-4, 9', 5), [1, 2, 3]);
  assert.deepStrictEqual(parseChoice('all', 3), [0, 1, 2]);
  assert.deepStrictEqual(parseChoice('', 3), []);
  assert.deepStrictEqual(parseChoice('no', 3), []);
});

test('cleanup explains its options, and -rn lists the biggest users without quitting', () => {
  const sh = shellIn(scratch);
  const errors = [];
  sh.errorOutput = (l) => errors.push(l);
  assert.strictEqual(sh.run('cleanup -x'), 2);
  assert.ok(errors.join(' ').includes('cleanup -r'));
  assert.strictEqual(sh.run('cleanup -rn < /dev/null'), 0);
  assert.ok(sh.lines.some((l) => /Memory .* in use/.test(ansi.strip(l))));
});

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* fine */ }

if (failures) {
  console.error(`\n${failures} palette test(s) failed`);
  process.exit(1);
}
console.log('\nall palette tests passed');
