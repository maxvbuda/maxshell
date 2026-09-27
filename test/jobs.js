'use strict';

// Job control and streaming pipelines. The foreground side (Ctrl-Z, fg)
// needs a real terminal and is checked through a pty by hand; here we test
// the helper, background jobs, and pipelines that must stream.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.MAXSHELL_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'mxjobs-cache-'));

const { Shell } = require('../src/interpreter');
const jobs = require('../src/jobs');

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

function sh(source) {
  const lines = [];
  const shell = new Shell({ output: (l) => lines.push(l), error: () => {} });
  shell.run(source);
  return { lines, shell };
}

const haveHelper = !!jobs.helperPath();

test('the job helper compiles into the cache', () => {
  if (!haveHelper) { console.log('  (no C compiler here; job control falls back)'); return; }
  assert.ok(fs.existsSync(jobs.helperPath()));
  assert.ok(jobs.helperPath().startsWith(process.env.MAXSHELL_CACHE));
});

test('the helper reports running, stopped, and how a job ended', () => {
  if (!haveHelper) return;
  const job = jobs.start(['sleep', '5'], { mode: 'bg', cwd: os.tmpdir(), env: process.env, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.strictEqual(job.state, 'running');
  assert.ok(job.pgid > 0, 'reports the process group');
  process.kill(-job.pgid, 'SIGSTOP');
  for (let i = 0; i < 100 && job.state !== 'stopped'; i++) { jobs.sleep(5); job.poll(); }
  assert.strictEqual(job.state, 'stopped');
  job.kill('SIGCONT');
  assert.strictEqual(job.state, 'running');
  job.kill('SIGTERM');
  for (let i = 0; i < 200 && !job.finished; i++) { jobs.sleep(5); job.poll(); }
  assert.strictEqual(job.state, 'done');
  assert.strictEqual(job.signal, 15);
  job.cleanup();
});

test('a background job is listed, waited for, and reports its status', () => {
  if (!haveHelper) return;
  const { shell } = sh('sh -c "sleep 0.2; exit 3" &');
  assert.strictEqual(shell.jobs.length, 1);
  assert.match(shell.jobLine(shell.jobs[0]), /^\[1\] {2}\+ running/);
  const status = shell.run('wait %1');
  assert.strictEqual(status, 3);
  assert.strictEqual(shell.jobs.length, 0);
});

test('kill %n ends a background job', () => {
  if (!haveHelper) return;
  const { shell } = sh('sleep 30 &');
  shell.run('kill %1');
  shell.run('wait');
  assert.strictEqual(shell.jobs.length, 0);
});

test('a compound command in the background keeps variables and functions', () => {
  if (!haveHelper) return;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxbg-')), 'out');
  sh(`x=42\nf() { echo "f sees $x"; }\n{ f; echo done } > ${out} &\nwait`);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'f sees 42\ndone\n');
});

test('job specs find jobs by number, prefix and substring', () => {
  if (!haveHelper) return;
  const { shell } = sh('sleep 30 &\nsh -c "sleep 30" &');
  assert.strictEqual(shell.findJob('%1').cmd, 'sleep 30');
  assert.strictEqual(shell.findJob('%sh').id, 2);
  assert.strictEqual(shell.findJob('%?-c').id, 2);
  assert.strictEqual(shell.findJob('%%').id, 2);
  shell.run('kill %1 %2\nwait');
});

test('pipelines stream: yes | head finishes', () => {
  const started = Date.now();
  assert.deepStrictEqual(sh('yes | head -3').lines, ['y', 'y', 'y']);
  assert.ok(Date.now() - started < 5000);
});

test('pipelines mix programs and builtins, and set $pipestatus', () => {
  assert.deepStrictEqual(sh('echo b a | tr " " "\\n" | sort | while read l; do echo "<$l>"; done').lines, ['<a>', '<b>']);
  assert.deepStrictEqual(sh('false | true\necho $pipestatus').lines, ['1 0']);
  assert.deepStrictEqual(sh('setopt pipefail\nsh -c "exit 2" | cat\necho $?').lines, ['2']);
  assert.deepStrictEqual(sh('ls /nonexistent-xyz 2>&1 | wc -l | tr -d " "').lines, ['1']);
});

if (failures) {
  console.error(`\n${failures} job test(s) failed`);
  process.exit(1);
}
console.log('\nall job tests passed');
