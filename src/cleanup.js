'use strict';

const os = require('os');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const { humanBytes, meter, fit } = require('./tui');
const { readProcesses } = require('./top');

// `cleanup -r` (memory) and `cleanup -c` (CPU): shows what is using the most
// of it, and quits the ones you pick. Nothing is quit without asking, and
// only your own programs are offered — never the system's, or this shell.
// Mac apps are asked to quit the normal way, so they can save your work.

// Processes that keep the Mac running: never offered.
const PROTECTED = new Set([
  'kernel_task', 'launchd', 'WindowServer', 'loginwindow', 'Finder', 'Dock', 'SystemUIServer',
  'ControlCenter', 'coreaudiod', 'mds', 'mds_stores', 'mdworker', 'mdworker_shared', 'distnoted',
  'cfprefsd', 'UserEventAgent', 'trustd', 'securityd', 'opendirectoryd', 'powerd', 'bluetoothd',
  'Terminal', 'iTerm2', 'login', 'sshd', 'tmux', 'screen', 'WindowManager', 'NotificationCenter',
]);

// The Mac app a process belongs to, e.g. "Google Chrome" for its helpers.
function appOf(command) {
  const m = /\/([^/]+)\.app\/Contents\//.exec(command);
  return m ? m[1] : null;
}

// Groups processes by app (Chrome's dozens of helpers count as one), keeps
// only the user's own and unprotected ones, and returns the top `limit` by
// memory ('r') or CPU ('c').
function hogs(procs, { kind = 'r', user = os.userInfo().username, exclude = new Set(), limit = 8 } = {}) {
  const groups = new Map();
  for (const p of procs) {
    if (p.user !== user || exclude.has(p.pid) || PROTECTED.has(p.name)) continue;
    const app = appOf(p.command);
    if (app && PROTECTED.has(app)) continue;
    const key = app || `${p.name}:${p.pid}`;
    let g = groups.get(key);
    if (!g) {
      g = { name: app || p.name, app, pids: [], rss: 0, cpu: 0, command: p.command };
      groups.set(key, g);
    }
    g.pids.push(p.pid);
    g.rss += p.rss;
    g.cpu += p.cpu;
  }
  const list = [...groups.values()];
  list.sort(kind === 'c' ? (a, b) => b.cpu - a.cpu || b.rss - a.rss : (a, b) => b.rss - a.rss || b.cpu - a.cpu);
  return list.filter((g) => (kind === 'c' ? g.cpu >= 1 : g.rss >= 20 * 1024 * 1024)).slice(0, limit);
}

// Memory really in use: macOS counts cache as used, so free + inactive +
// speculative pages are what's available.
function memoryUse() {
  const total = os.totalmem();
  let used = total - os.freemem();
  if (process.platform === 'darwin') {
    const vm = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 1500 }).stdout || '';
    const page = Number((/page size of (\d+)/.exec(vm) || [])[1]) || 16384;
    const pages = (k) => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(vm) || [])[1]) || 0;
    if (vm) used = total - (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page;
  }
  return { total, used };
}

function cpuUse() {
  const [one] = os.loadavg();
  return Math.min(1, one / os.cpus().length);
}

// Parses "1 3-5 all" into indexes (1-based in, 0-based out).
function parseChoice(text, count) {
  const t = text.trim().toLowerCase();
  if (!t || t === 'n' || t === 'no' || t === 'q') return [];
  if (t === 'all' || t === 'a') return [...Array(count).keys()];
  const out = new Set();
  for (const part of t.split(/[\s,]+/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

// Quits one group: apps through AppleScript (a normal Quit), other programs
// with SIGTERM (a polite request to stop).
function quit(g) {
  if (g.app && process.platform === 'darwin') {
    const r = spawnSync('osascript', ['-e', `quit app "${g.app.replace(/"/g, '\\"')}"`], { timeout: 15000 });
    if (r.status === 0) return true;
  }
  let ok = false;
  for (const pid of g.pids) { try { process.kill(pid, 'SIGTERM'); ok = true; } catch { /* already gone */ } }
  return ok;
}

function runCleanup(args, io, shell) {
  const out = (t) => shell.writeTo(io.stdout, t);
  const err = (t) => shell.writeTo(io.stderr, t);
  const flags = args.join('');
  const kind = /c/.test(flags) ? 'c' : /r/.test(flags) ? 'r' : null;
  if (!kind || args.some((a) => !/^-[rc]+$/.test(a))) {
    err('usage: cleanup -r   free memory: quit what uses the most RAM\n'
      + '       cleanup -c   free the CPU: quit what is keeping it busy\n');
    return 2;
  }
  const t = theme.current();
  const R = ansi.reset();
  const mu = (s) => `${ansi.fg(t.ui.muted)}${s}${R}`;
  const procs = readProcesses();
  if (!procs) { err('cleanup: could not list processes\n'); return 1; }

  // Never offer this shell, its parents (the terminal), or its children.
  const exclude = new Set([process.pid, process.ppid]);
  for (let pid = process.ppid, n = 0; pid > 1 && n < 20; n++) {
    const p = procs.find((x) => x.pid === pid);
    if (!p) break;
    exclude.add(p.pid);
    pid = p.ppid;
  }

  const before = kind === 'r' ? memoryUse() : null;
  if (kind === 'r') out(`Memory ${meter(before.used / before.total, 24)} ${humanBytes(before.used)} of ${humanBytes(before.total)} in use\n\n`);
  else out(`CPU    ${meter(cpuUse(), 24)} ${Math.round(cpuUse() * 100)}% busy ${mu(`(load ${os.loadavg()[0].toFixed(2)} on ${os.cpus().length} cores)`)}\n\n`);

  const list = hogs(procs, { kind, exclude });
  if (!list.length) {
    out(`${ansi.fg(t.ui.ok)}✓${R} nothing of yours is using much ${kind === 'r' ? 'memory' : 'CPU'} right now\n`);
    return 0;
  }
  const nameW = Math.min(32, Math.max(...list.map((g) => g.name.length)) + 2);
  list.forEach((g, i) => {
    const amount = kind === 'r' ? humanBytes(g.rss).padStart(8) : `${g.cpu.toFixed(1)}%`.padStart(7);
    const extra = g.pids.length > 1 ? mu(`${g.pids.length} processes`) : mu(`pid ${g.pids[0]}`);
    out(`  ${ansi.fg(t.ui.accent)}${String(i + 1).padStart(2)}${R}  ${fit(g.name, nameW)}${amount}   ${extra}\n`);
  });

  let choice;
  if (process.stdin.isTTY && io.stdin.kind === 'term') {
    out(`\nQuit which? ${mu('numbers like 1 3 or 2-4, "all", or Enter for none')} `);
    const line = shell.readLine(io.stdin);
    choice = parseChoice(line || '', list.length);
  } else {
    out(`\n${mu('run cleanup at the prompt to choose what to quit')}\n`);
    return 0;
  }
  if (!choice.length) { out(mu('nothing quit\n')); return 0; }

  for (const i of choice) {
    const g = list[i];
    out(`${quit(g) ? `${ansi.fg(t.ui.ok)}✓${R} quit` : `${ansi.fg(t.ui.err)}✗${R} could not quit`} ${g.name}\n`);
  }

  if (kind === 'r') {
    // Give the programs a moment to exit, then show what was freed.
    spawnSync('sleep', ['1.5']);
    const after = memoryUse();
    const freed = before.used - after.used;
    out(`\nMemory ${meter(after.used / after.total, 24)} ${humanBytes(after.used)} in use`
      + `${freed > 0 ? ` ${ansi.fg(t.ui.ok)}(${humanBytes(freed)} freed)${R}` : ''}\n`);
  } else {
    out(mu('\nthe CPU settles over the next few seconds\n'));
  }
  return 0;
}

module.exports = { runCleanup, hogs, parseChoice, appOf, PROTECTED };
