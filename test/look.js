'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ansi = require('../src/ansi');
const theme = require('../src/theme');
const { LOGO, logoLines, banner } = require('../src/banner');
const { promptParts, compactPrompt, usesDefaultPrompt } = require('../src/prompt');
const { colorFor } = require('../src/paint');
const { highlight } = require('../src/highlight');
const { textWidth, bar } = require('../src/tui');
const { Shell } = require('../src/interpreter');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`not ok - ${name}\n  ${e.message}`);
  }
  theme.setTheme(theme.DEFAULT);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mxlook-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
process.env.MAXSHELL_THEME_FILE = path.join(scratch, 'theme');

ansi.setEnabled(true);
const shell = () => new Shell({ output: () => {}, error: () => {} });
const colorNum = (s) => s.c ?? s;

// --- the themes -----------------------------------------------------------------

const SYNTAX = ['kw', 'const', 'builtin', 'str', 'num', 'comment', 'decorator', 'defname', 'op',
  'key', 'var', 'heading', 'emph', 'code', 'link', 'quote', 'bullet'];
const SHELL = ['reserved', 'builtin', 'command', 'alias', 'unknown', 'string', 'variable', 'operator', 'comment', 'assign'];
const UI = ['accent', 'accent2', 'muted', 'ok', 'err', 'warn', 'selectDim', 'marked', 'dir'];
const PROMPT = ['path', 'branch', 'marks', 'char', 'charErr', 'right', 'frame'];

test('there are eight themes and every one defines every colour', () => {
  assert.strictEqual(theme.names().length, 8);
  const valid = (v) => Number.isInteger(colorNum(v)) && colorNum(v) >= 0 && colorNum(v) <= 255;
  for (const name of theme.names()) {
    const t = theme.THEMES[name];
    assert.ok(t.description, `${name} description`);
    assert.ok(t.gradient.length >= 5 && t.gradient.every(valid), `${name} gradient`);
    for (const k of UI) assert.ok(valid(t.ui[k]), `${name} ui.${k}`);
    for (const k of ['fg', 'bg']) { assert.ok(valid(t.ui.bar[k]), `${name} bar`); assert.ok(valid(t.ui.select[k]), `${name} select`); }
    for (const k of ['t', 'h', 'f', 'b', 's']) assert.ok(valid(t.ui.folder[k]), `${name} folder.${k}`);
    for (const k of PROMPT) assert.ok(valid(t.prompt[k]), `${name} prompt.${k}`);
    for (const k of SHELL) assert.ok(valid(t.shell[k]), `${name} shell.${k}`);
    for (const k of SYNTAX) assert.ok(valid(t.syntax[k]), `${name} syntax.${k}`);
  }
});

test('switching themes changes code colours, the command line, and bars', () => {
  const kwBefore = colorFor('kw');
  const lineBefore = highlight('git status', shell());
  const barBefore = bar('title', 20);
  theme.setTheme('gruvbox');
  assert.notStrictEqual(colorFor('kw'), kwBefore);
  assert.notStrictEqual(highlight('git status', shell()), lineBefore);
  assert.notStrictEqual(bar('title', 20), barBefore);
  assert.ok(bar('title', 20).includes('48;5;237'), 'bar uses the theme background');
});

test('the default theme keeps the familiar command-line colours', () => {
  assert.ok(highlight('definitelynotacommandxyz', shell()).startsWith(ansi.fg('red')), 'unknown commands red');
});

test('withTheme previews another theme and restores the current one', () => {
  const inside = theme.withTheme('nord', () => theme.currentThemeName());
  assert.strictEqual(inside, 'nord');
  assert.strictEqual(theme.currentThemeName(), theme.DEFAULT);
});

test('a chosen theme is saved and loaded; MAXSHELL_THEME overrides for a session', () => {
  theme.saveTheme('sunset');
  theme.setTheme('maxshell');
  assert.strictEqual(theme.loadSavedTheme(), 'sunset');
  process.env.MAXSHELL_THEME = 'mono';
  assert.strictEqual(theme.loadSavedTheme(), 'mono');
  delete process.env.MAXSHELL_THEME;
  assert.strictEqual(theme.setTheme('not-a-theme'), false);
});

test('folder icons are drawn in the theme’s folder colours', () => {
  const { iconArt } = require('../src/files');
  const art = () => iconArt({ name: 'plain', isDir: true }).join('');
  theme.setTheme('gruvbox');
  assert.ok(art().includes(`48;5;${theme.current().ui.folder.f}m`));
  theme.setTheme('nord');
  assert.ok(art().includes(`48;5;${theme.current().ui.folder.f}m`));
});

// --- the logo and banner -----------------------------------------------------------

test('the logo rows line up and are painted across the gradient', () => {
  assert.strictEqual(LOGO[0].length, LOGO[1].length);
  const lines = logoLines();
  lines.forEach((l, i) => assert.strictEqual(ansi.strip(l), LOGO[i]));
  const colours = new Set([...lines[0].matchAll(/38;5;(\d+)m/g)].map((m) => m[1]));
  assert.ok(colours.size >= 5, `several colours across the logo (got ${colours.size})`);
});

test('the banner sits beside the logo when wide and stacks when narrow', () => {
  const wide = ansi.strip(banner({ version: '9.9', cols: 140, tip: 'a tip' })).split('\n').filter(Boolean);
  assert.strictEqual(wide.length, 2);
  assert.match(wide[0], /maxshell 9\.9 · theme maxshell/);
  const narrow = ansi.strip(banner({ version: '9.9', cols: 50, tip: 'a tip' })).split('\n').filter(Boolean);
  assert.strictEqual(narrow.length, 4);
  assert.match(narrow[3], /tip: a tip/);
});

// --- the prompt -----------------------------------------------------------------

test('the prompt is one line that never wraps', () => {
  const sh = shell();
  for (const cols of [30, 60, 100, 200]) {
    const { input, right } = promptParts(sh, cols);
    assert.ok(!input.includes('\n'));
    const w = textWidth(ansi.strip(input)) + textWidth(ansi.strip(right));
    assert.ok(w <= cols - 1, `${cols} cols: ${ansi.strip(input)}${ansi.strip(right)}`);
    assert.match(ansi.strip(input), /maxshell.* ❯ $/);
  }
  // In this repository (a Node project) the right side shows the Node module.
  assert.match(ansi.strip(promptParts(sh, 120).right), /⬢ \d+\.\d+\.\d+/);
});

test('the prompt shows the folder, and follows cd', () => {
  const sh = shell();
  sh.run('cd src');
  assert.match(ansi.strip(promptParts(sh, 80).input), /^\S*maxshell\/src · \S+.* ❯ $/);
  sh.run('cd /');
  assert.strictEqual(ansi.strip(promptParts(sh, 80).input), '/ ❯ ');
});

test('the terminal is told the folder, for its title and new tabs', () => {
  const { terminalTitle } = require('../src/prompt');
  const sh = shell();
  sh.run('cd /tmp');
  const t = terminalTitle(sh);
  assert.match(t, /\x1b\]7;file:\/\/[^/]*\/.*tmp\x07/);
  assert.match(t, /\x1b\]0;\/.*tmp\x07/);
});

test('the ❯ turns the error colour after a failed command', () => {
  const sh = shell();
  const ok = promptParts(sh, 80).input;
  sh.run('false');
  const bad = promptParts(sh, 80).input;
  assert.ok(bad.includes(`38;5;${theme.current().prompt.charErr}m❯`));
  assert.notStrictEqual(ok, bad);
  sh.status = 130;
  assert.ok(promptParts(sh, 80).input.includes(`38;5;${theme.current().prompt.char}m❯`), 'Ctrl-C is not an error');
});

test('a custom PROMPT switches off the signature prompt', () => {
  const sh = shell();
  assert.strictEqual(usesDefaultPrompt(sh), true);
  sh.run("PROMPT='%~ $ '");
  assert.strictEqual(usesDefaultPrompt(sh), false);
});

test('finished prompts collapse to one line', () => {
  const sh = shell();
  const line = ansi.strip(compactPrompt(sh, 'git status'));
  assert.match(line, /^\S+ ❯ git status$/);
});

test('theme colour names work in a custom prompt', () => {
  const { expandPrompt } = require('../src/prompt');
  theme.setTheme('dracula');
  assert.strictEqual(expandPrompt('%F{accent}', shell()), ansi.fg(theme.current().ui.accent));
});

// --- the theme command ----------------------------------------------------------

test('theme lists every theme, marking the current one', () => {
  const lines = [];
  const sh = new Shell({ output: (l) => lines.push(ansi.strip(l)), error: () => {} });
  sh.run('theme');
  for (const name of theme.names()) assert.ok(lines.some((l) => l.includes(name)), name);
  assert.ok(lines.some((l) => l.startsWith('● maxshell')));
});

test('theme <name> switches, saves, and catches typos', () => {
  const lines = [];
  const errors = [];
  const sh = new Shell({ output: (l) => lines.push(ansi.strip(l)), error: (l) => errors.push(l) });
  assert.strictEqual(sh.run('theme tokyo-nigth'), 1);
  assert.match(errors.join(''), /did you mean tokyo-night\?/);
  assert.strictEqual(sh.run('theme tokyo-night'), 0);
  assert.strictEqual(theme.currentThemeName(), 'tokyo-night');
  assert.strictEqual(fs.readFileSync(process.env.MAXSHELL_THEME_FILE, 'utf8').trim(), 'tokyo-night');
  assert.ok(lines.some((l) => /✓ theme tokyo-night/.test(l)));
});

if (failures) {
  console.error(`\n${failures} look test(s) failed`);
  process.exit(1);
}
console.log('\nall look tests passed');
