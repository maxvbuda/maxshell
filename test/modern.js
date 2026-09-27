'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const ansi = require('../src/ansi');
const { completions } = require('../src/complete');
const { LineEditor } = require('../src/lineeditor');
const { detect, promptModules, clearCaches } = require('../src/context');
const { promptParts } = require('../src/prompt');
const ls = require('../src/ls');
const { textWidth } = require('../src/tui');
const { Shell } = require('../src/interpreter');

let failures = 0;
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try {
      ansi.setEnabled(false);
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failures++;
      console.error(`not ok - ${name}\n  ${e.message}`);
    } finally {
      ansi.setEnabled(false);
    }
  });
}

const scratch = [];
process.on('exit', () => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mxmod-')));
  scratch.push(d);
  return d;
}
const shellIn = (cwd) => new Shell({ output: () => {}, error: () => {}, cwd });
ansi.setEnabled(false);

// --- context-aware completion -----------------------------------------------------

const names = (r) => r.items;
const at = (line, sh) => completions(line, line.length, sh);

test('commands come with icons and descriptions', () => {
  const r = at('ec', shellIn(process.cwd()));
  assert.ok(r.items.includes('echo'));
  assert.deepStrictEqual(r.info.get('echo'), { icon: '◆', desc: 'print text' });
});

test('git subcommands are explained', () => {
  const r = at('git st', shellIn(process.cwd()));
  assert.deepStrictEqual(names(r), ['stash', 'status']);
  assert.strictEqual(r.info.get('status').desc, 'what has changed');
});

test('git checkout offers branches', () => {
  const dir = tmp();
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  spawnSync('git', ['-C', dir, 'branch', 'feature-login']);
  const r = at('git checkout f', shellIn(dir));
  assert.deepStrictEqual(names(r), ['feature-login']);
  assert.strictEqual(r.info.get('feature-login').icon, '⎇');
});

test('npm run lists this project’s scripts with what they run', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'jest' } }));
  fs.mkdirSync(path.join(dir, 'sub'));
  const r = at('npm run ', shellIn(path.join(dir, 'sub')));
  assert.deepStrictEqual(names(r), ['build', 'test']);
  assert.strictEqual(r.info.get('build').desc, 'tsc');
});

test('cd and j offer folders only; other commands get files with kinds', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'setup.py'), 'x = 1\n');
  assert.deepStrictEqual(names(at('cd s', shellIn(dir))), ['src/']);
  assert.deepStrictEqual(names(at('j s', shellIn(dir))), ['src/']);
  const r = at('cat s', shellIn(dir));
  assert.deepStrictEqual(names(r), ['setup.py', 'src/']);
  assert.match(r.info.get('setup.py').desc, /^Python source · \d/);
  assert.strictEqual(r.info.get('setup.py').icon, '🐍');
});

test('theme completes theme names with their descriptions', () => {
  const r = at('theme d', shellIn(process.cwd()));
  assert.deepStrictEqual(names(r), ['dracula']);
  assert.match(r.info.get('dracula').desc, /purple/);
});

// --- the completion menu ----------------------------------------------------------

class FakeInput extends EventEmitter { setRawMode() {} resume() {} pause() {} }

function menuEditor(cwd) {
  const input = new FakeInput();
  const output = { columns: 90, rows: 30, data: '', write(s) { this.data += s; } };
  const ed = new LineEditor({ input, output, shell: shellIn(cwd), complete: completions, history: [] });
  const promise = ed.read('% ', '');
  const key = (name, extra = {}) => input.emit('keypress', extra.str || '', { name, ...extra });
  const type = (text) => { for (const ch of text) input.emit('keypress', ch, { name: ch }); };
  return { ed, promise, key, type, output };
}

test('Tab opens a menu when there are several choices', () => {
  const { ed, key, type } = menuEditor(process.cwd());
  type('git st');
  key('tab');
  assert.ok(ed.menu, 'menu is open');
  assert.deepStrictEqual(ed.menu.items, ['stash', 'status']);
  assert.strictEqual(ed.buf, 'git sta', 'the shared start is filled in, the rest is chosen from the menu');
});

test('Tab and arrows move; Enter picks without running', async () => {
  const { ed, promise, key, type } = menuEditor(process.cwd());
  type('git st');
  key('tab');
  key('tab');
  assert.strictEqual(ed.menu.index, 1);
  key('up');
  key('down');
  key('return');
  assert.strictEqual(ed.menu, null);
  assert.strictEqual(ed.buf, 'git status ');
  key('return');
  assert.deepStrictEqual(await promise, { line: 'git status ' });
});

test('typing narrows the open menu, and Escape closes it', () => {
  const { ed, key, type } = menuEditor(process.cwd());
  type('git s');
  key('tab');
  const before = ed.menu.items.length;
  type('t');
  assert.ok(ed.menu.items.length < before);
  assert.deepStrictEqual(ed.menu.items, ['stash', 'status']);
  key('escape');
  assert.strictEqual(ed.menu, null);
  assert.strictEqual(ed.buf, 'git st');
});

test('a single match still completes straight away', () => {
  const { ed, key, type } = menuEditor(process.cwd());
  type('git stat');
  key('tab');
  assert.strictEqual(ed.menu, null);
  assert.strictEqual(ed.buf, 'git status ');
});

test('the menu draws icons and descriptions within the terminal width', () => {
  ansi.setEnabled(true);
  const { key, type, output } = menuEditor(process.cwd());
  type('git st');
  key('tab');
  const frame = output.data.split('\r\x1b[J').pop();
  const text = ansi.strip(frame);
  assert.match(text, /›\s+stash\s+shelve changes/);
  assert.match(text, /›\s+status\s+what has changed/);
  for (const line of text.split('\r\n')) {
    const clean = line.replace(/\r/g, '');
    assert.ok(textWidth(clean) < 90, `fits: ${JSON.stringify(clean)}`);
  }
  ansi.setEnabled(false);
});

// --- the context-aware prompt -----------------------------------------------------

test('project detection finds the tools a folder uses', () => {
  clearCaches();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '2.3.4' }));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '');
  fs.mkdirSync(path.join(root, 'deep', 'er'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  const found = detect(path.join(root, 'deep', 'er'), os.homedir());
  assert.deepStrictEqual(found.modules.map((m) => m.id).sort(), ['node', 'rust']);
  assert.deepStrictEqual(found.pkg, { name: 'demo', version: '2.3.4' });
});

test('detection stops at the repository root', () => {
  clearCaches();
  const outer = tmp();
  fs.writeFileSync(path.join(outer, 'package.json'), '{}');
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.deepStrictEqual(detect(repo, os.homedir()).modules, [], 'the parent’s package.json does not leak in');
});

test('Python projects show the virtualenv', () => {
  clearCaches();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '');
  const sh = shellIn(dir);
  sh.setVar('VIRTUAL_ENV', '/somewhere/.venv');
  const py = promptModules(sh).find((m) => m.id === 'python');
  assert.ok(py, 'python module present');
  assert.match(py.text, /^🐍 .*\(\.venv\)$/);
});

test('a plain folder shows just the time; a slow command adds "took"', () => {
  clearCaches();
  const sh = shellIn(tmp());
  ansi.setEnabled(true);
  const plain = ansi.strip(promptParts(sh, 100).right);
  assert.match(plain, /\d\d:\d\d$/);
  assert.ok(!/⬢|📦|took/.test(plain));
  sh.lastDuration = 3500;
  assert.match(ansi.strip(promptParts(sh, 100).right), /took 3\.5s · \d\d:\d\d$/);
  ansi.setEnabled(false);
});

test('long paths shorten fish-style', () => {
  const { shortenPath } = require('../src/prompt');
  assert.strictEqual(shortenPath('~/projects/website/src', 30), '~/projects/website/src');
  assert.strictEqual(shortenPath('~/projects/website/src', 12), '~/p/w/src');
  assert.strictEqual(shortenPath('/private/var/folders/pr/abc', 16), '/p/v/f/p/abc');
  assert.strictEqual(shortenPath('~/.config/nvim/lua', 12), '~/.c/n/lua');
  assert.strictEqual(shortenPath('/a/b/c/d/e/f/g/h/i/j/k/really-long-name', 12), '…/really-long-name'.slice(0, 1) + 'really-long-name'.slice(-11));
});

test('when space runs out, modules go before the time does', () => {
  clearCaches();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const sh = shellIn(dir);
  ansi.setEnabled(true);
  for (const cols of [40, 70, 120]) {
    const { input, right } = promptParts(sh, cols);
    const h = ansi.strip(input) + ansi.strip(right);
    assert.ok(textWidth(h) <= cols - 1, `${cols}: ${h}`);
    if (cols >= 70) assert.match(h, /\d\d:\d\d$/, 'the time survives');
  }
  ansi.setEnabled(false);
});

// --- ls -----------------------------------------------------------------------------

function lsTree() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'zeta'));
  fs.mkdirSync(path.join(dir, 'alpha'));
  fs.writeFileSync(path.join(dir, 'b.py'), 'x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, '.hidden'), '');
  fs.writeFileSync(path.join(dir, 'alpha', 'inner.md'), '#');
  return dir;
}

test('ls lists folders first, with icons, and hides dotfiles unless -a', () => {
  const dir = lsTree();
  const out = ls.render(['-1'], dir, 80).lines;
  assert.deepStrictEqual(out, ['📁 alpha/', '📁 zeta/', '📝 a.txt', '🐍 b.py']);
  assert.ok(ls.render(['-1a'], dir, 80).lines.some((l) => l.includes('.hidden')));
});

test('the grid never exceeds the terminal width', () => {
  const dir = tmp();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `file-number-${i}.txt`), '');
  for (const cols of [30, 60, 120]) {
    for (const line of ls.render([], dir, cols).lines) {
      assert.ok(textWidth(ansi.strip(line)) <= cols, `${cols}: ${line}`);
    }
  }
});

test('ls -l shows permissions, size, date and git status', () => {
  const dir = lsTree();
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'add', 'a.txt']);
  spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  const out = ls.render(['-l'], dir, 100).lines;
  assert.match(out[0], /Permissions\s+Size\s+Modified\s+Git\s+Name/);
  const aLine = out.find((l) => l.includes('a.txt'));
  assert.match(aLine, /^\.rw-/);
  assert.match(aLine, /\b7B\b/);
  assert.match(aLine, /\sM\s+📝 a\.txt/, 'modified file marked M');
  assert.match(out.find((l) => l.includes('b.py')), /\sN\s+🐍 b\.py/, 'new file marked N');
  assert.match(out.find((l) => l.includes('alpha')), /\sN\s+📁 alpha\//, 'folders inherit their contents’ status');
});

test('ls --tree draws branches and respects --level', () => {
  const dir = lsTree();
  const full = ls.render(['--tree'], dir, 80).lines;
  assert.ok(full.includes('│   └── 📝 inner.md'), full.join('\n'));
  const shallow = ls.render(['--tree', '--level=1'], dir, 80).lines;
  assert.ok(!shallow.some((l) => l.includes('inner.md')));
});

test('unfamiliar flags hand over to the real ls', () => {
  assert.strictEqual(ls.render(['--color=always'], process.cwd(), 80), null);
  assert.strictEqual(ls.render(['-F'], process.cwd(), 80), null);
});

test('in scripts and pipes, ls is the real ls', () => {
  const dir = lsTree();
  const lines = [];
  const sh = new Shell({ output: (l) => lines.push(l), error: () => {}, cwd: dir });
  sh.run('ls');
  const real = spawnSync('ls', [], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepStrictEqual(lines, real);
});

(async () => {
  for (const t of queue) await t();
  if (failures) {
    console.error(`\n${failures} modern test(s) failed`);
    process.exit(1);
  }
  console.log('\nall modern tests passed');
})();
