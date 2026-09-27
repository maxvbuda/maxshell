'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// Job control. Node can't create process groups, hand the terminal over, or
// notice that a child has stopped, so a tiny C helper (jobrun.c) does those
// parts. It's compiled once, on first use, into a cache folder; without a C
// compiler, maxshell simply runs commands the old way (no Ctrl-Z).

const SOURCE = path.join(__dirname, 'jobrun.c');
let helper; // undefined: not looked for yet; null: unavailable

function cacheDir() {
  return process.env.MAXSHELL_CACHE || path.join(os.homedir(), '.cache', 'maxshell');
}

function helperPath() {
  if (helper !== undefined) return helper;
  helper = null;
  if (process.env.MAXSHELL_JOBS === '0') return helper;
  try {
    const src = fs.readFileSync(SOURCE);
    const hash = crypto.createHash('sha1').update(src).update(process.platform + process.arch).digest('hex').slice(0, 12);
    const bin = path.join(cacheDir(), `jobrun-${hash}`);
    if (fs.existsSync(bin)) { helper = bin; return helper; }
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${bin}.${process.pid}`;
    for (const cc of ['cc', 'clang', 'gcc']) {
      const r = spawnSync(cc, ['-O2', '-o', tmp, SOURCE], { stdio: 'ignore', timeout: 30000 });
      if (r.status === 0 && fs.existsSync(tmp)) {
        fs.renameSync(tmp, bin);
        helper = bin;
        break;
      }
    }
  } catch { helper = null; }
  return helper;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(sleeper, 0, 0, ms); }

let madeDir = null;
function statusDir() {
  const dir = path.join(os.tmpdir(), `maxshell-jobs-${process.pid}`);
  if (!madeDir) {
    fs.mkdirSync(dir, { recursive: true });
    madeDir = dir;
    // Jobs that outlive the shell just can't report any more.
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });
  }
  return dir;
}

let seq = 0;

class Job {
  constructor({ cmd, helperPid, statusFile }) {
    this.cmd = cmd;
    this.helperPid = helperPid;
    this.statusFile = statusFile;
    this.state = 'running';
    this.code = null;
    this.signal = null;
    this.pgid = null;
    this.id = null;
    this.notified = false;
  }

  // Re-reads the helper's status file. Returns true if it changed.
  poll() {
    let text;
    try { text = fs.readFileSync(this.statusFile, 'utf8').trim(); } catch { return false; }
    const [state, n] = text.split(/\s+/);
    const num = Number(n);
    const before = `${this.state} ${this.code} ${this.signal}`;
    if (state === 'running') {
      this.state = 'running';
      if (num) this.pgid = num;
    } else if (state === 'stopped') {
      this.state = 'stopped';
      this.signal = num;
    } else if (state === 'exit') {
      this.state = 'done';
      this.code = num;
    } else if (state === 'signal') {
      this.state = 'done';
      this.signal = num;
      this.code = 128 + num;
    }
    return before !== `${this.state} ${this.code} ${this.signal}`;
  }

  get finished() { return this.state === 'done'; }

  // Waits while the job runs in the foreground: until it stops or ends.
  waitForeground() {
    for (;;) {
      this.poll();
      if (this.state !== 'running') return this;
      sleep(8);
    }
  }

  // Sends the helper a request and waits until it has acted on it (the
  // status file is rewritten), resending once in a while in case a signal
  // arrived at an awkward moment.
  request(sig) {
    try { fs.unlinkSync(this.statusFile); } catch { /* not there */ }
    for (let tries = 0; tries < 50; tries++) {
      try { process.kill(this.helperPid, sig); } catch { this.state = 'done'; return; }
      for (let i = 0; i < 25; i++) {
        if (fs.existsSync(this.statusFile)) { this.poll(); return; }
        sleep(8);
      }
    }
  }

  foreground() {
    this.request('SIGUSR1');
    if (this.state === 'running') this.waitForeground();
    return this;
  }

  background() {
    this.request('SIGUSR2');
    return this;
  }

  // Sends a signal to every process in the job.
  kill(sig) {
    this.poll();
    // Continuing goes through the helper so it knows the job runs again
    // (macOS doesn't report continued children).
    if (sig === 'SIGCONT' && this.state === 'stopped') { this.background(); return; }
    const target = this.pgid ? -this.pgid : this.helperPid;
    process.kill(target, sig);
    // A stopped job can't act on a signal until it runs again.
    if (this.state === 'stopped' && sig !== 'SIGCONT' && sig !== 'SIGSTOP') {
      try { process.kill(target, 'SIGCONT'); } catch { /* gone */ }
    }
  }

  hangup() {
    try { process.kill(this.helperPid, 'SIGHUP'); } catch { /* gone */ }
  }

  cleanup() {
    try { fs.unlinkSync(this.statusFile); } catch { /* gone */ }
  }
}

// Starts argv through the helper. `mode` is 'fg' (it gets the terminal) or
// 'bg'. `stdio` entries are 'inherit', 'ignore' or file descriptors.
function start(argv, { mode, cwd, env, stdio, cmd }) {
  const bin = helperPath();
  if (!bin) return null;
  const statusFile = path.join(statusDir(), `job${++seq}`);
  try { fs.unlinkSync(statusFile); } catch { /* fresh */ }
  let child;
  try {
    child = spawn(bin, [statusFile, mode, ...argv], { cwd, env, stdio });
  } catch { return null; }
  if (!child.pid) return null;
  // Node would otherwise keep the helper's pipes and handle referenced.
  child.unref();
  child.on('error', () => {});
  const job = new Job({ cmd: cmd || argv.join(' '), helperPid: child.pid, statusFile });
  // Wait until the helper has started the program (and reported its pgid).
  for (let i = 0; i < 500 && !fs.existsSync(statusFile); i++) sleep(2);
  job.poll();
  return job;
}

module.exports = { helperPath, start, Job, sleep };
