#!/usr/bin/env node
'use strict';

// Runs every program in ai/mx2/code/ and checks its output, so only code
// that really works can enter mx2's dataset.
//
//   node ai/mx2/validate.js          # all
//   node ai/mx2/validate.js basics   # one file

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, 'code');

const RUNNERS = {
  python: { ext: 'py', run: (f, args) => ['python3', [f, ...args]], check: (f) => ['python3', ['-m', 'py_compile', f]] },
  javascript: { ext: 'js', run: (f, args) => ['node', [f, ...args]], check: (f) => ['node', ['--check', f]] },
  bash: { ext: 'sh', run: (f, args) => ['bash', [f, ...args]], check: (f) => ['bash', ['-n', f]] },
  sql: { ext: 'sql', run: (f) => ['sh', ['-c', `sqlite3 :memory: < "${f}"`]], check: (f) => ['sh', ['-c', `sqlite3 :memory: < "${f}"`]] },
  cpp: {
    ext: 'cpp',
    run: (f, args) => ['sh', ['-c', `c++ -std=c++17 -Wall -Werror -o prog "${f}" && ./prog ${args.map((a) => `'${a}'`).join(' ')}`]],
    check: (f) => ['c++', ['-std=c++17', '-fsyntax-only', f]],
  },
  swift: {
    ext: 'swift',
    run: (f) => ['sh', ['-c', `swiftc -o prog "${f}" 2>&1 >/dev/null | grep -v warning; ./prog`]],
    check: (f) => ['swiftc', ['-parse', f]],
  },
  ruby: { ext: 'rb', run: (f, args) => ['ruby', [f, ...args]], check: (f) => ['ruby', ['-c', f]] },
  perl: { ext: 'pl', run: (f, args) => ['perl', [f, ...args]], check: (f) => ['perl', ['-c', f]] },
  c: {
    ext: 'c',
    run: (f, args) => ['sh', ['-c', `cc -Wall -Werror -o prog "${f}" -lm && ./prog ${args.map((a) => `'${a}'`).join(' ')}`]],
    check: (f) => ['cc', ['-fsyntax-only', f]],
  },
};

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// An HTML page: tags open and close in order, the basics are there, CSS
// braces balance, and every script compiles.
function validateHtml(code, { fragment = false } = {}) {
  const vm = require('vm');
  const scripts = [];
  const styles = [];
  const body = code
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, js) => { scripts.push(js); return '<script></script>'; })
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => { styles.push(css); return '<style></style>'; })
    .replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, rawName, selfClose] = m;
    const name = rawName.toLowerCase();
    if (VOID.has(name) || selfClose) continue;
    if (!closing) stack.push(name);
    else {
      const top = stack.pop();
      if (top !== name) return `<${top || 'nothing'}> closed by </${name}>`;
    }
  }
  if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
  if (!fragment && !/<!DOCTYPE html>/i.test(code)) return 'no <!DOCTYPE html>';
  if (!fragment && !/<meta name="viewport"/.test(code)) return 'no viewport meta (not mobile friendly)';
  for (const css of styles) {
    let depth = 0;
    for (const c of css) { if (c === '{') depth++; if (c === '}') depth--; if (depth < 0) return 'CSS: } without {'; }
    if (depth) return 'CSS: unbalanced braces';
  }
  for (const js of scripts) {
    try { new vm.Script(js); } catch (e) { return `script: ${e.message}`; }
  }
  return null;
}

// Checks one implementation; returns null when it passes, else the problem.
function validate(lang, impl) {
  if (lang === 'html') return validateHtml(impl.code, impl.run || {});
  if (lang === 'css') {
    let depth = 0;
    for (const c of impl.code) { if (c === '{') depth++; if (c === '}') depth--; if (depth < 0) return 'CSS: } without {'; }
    return depth ? 'CSS: unbalanced braces' : null;
  }
  const runner = RUNNERS[lang];
  // Languages without a toolchain on this Mac can't be checked; they must
  // say so, and the dataset marks them.
  if (!runner) return (impl.run || {}).unverified ? null : `no runner for ${lang} (mark run.unverified)`;
  const run = impl.run || {};
  if (run.skip) {
    // Still has to be valid code.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx2v-'));
    const file = path.join(dir, `prog.${runner.ext}`);
    fs.writeFileSync(file, `${impl.code}\n`);
    const [cmd, args] = runner.check(file);
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 20000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return r.status === 0 ? null : `does not compile: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx2v-'));
  try {
    for (const [name, content] of Object.entries(run.files || {})) fs.writeFileSync(path.join(dir, name), content);
    const file = path.join(dir, `prog.${runner.ext}`);
    fs.writeFileSync(file, `${impl.code}\n`);
    const [cmd, args] = run.syntax ? runner.check(file) : runner.run(file, run.args || []);
    const r = spawnSync(cmd, args, { cwd: dir, input: run.stdin || '', encoding: 'utf8', timeout: lang === 'swift' ? 180000 : 20000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    if (r.error) return `could not run: ${r.error.message}`;
    if (r.status !== 0) return `exit ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`;
    if (run.syntax) return null;
    let out = r.stdout;
    // Programs that list files see their own source too; ignore it.
    out = out.split('\n').filter((l) => !/^prog(\.\w+)?$/.test(l)).join('\n');
    if (out !== run.out) return `wrong output:\n      expected ${JSON.stringify(run.out)}\n      got      ${JSON.stringify(out)}`;
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const only = process.argv[2];
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && (!only || f.startsWith(only)));
  let ok = 0;
  let bad = 0;
  for (const f of files) {
    const entries = require(path.join(DIR, f));
    for (const entry of entries) {
      for (const [lang, impl] of Object.entries(entry.impls || {})) {
        const problem = validate(lang, impl);
        if (problem) { bad++; console.log(`✗ ${f} · ${entry.task} · ${lang}\n    ${problem}`); } else ok++;
      }
    }
  }
  console.log(`\n${ok} programs work, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();

module.exports = { validate, validateHtml, RUNNERS };
