'use strict';

const os = require('os');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const { humanBytes, meter, fit } = require('./tui');
const { readProcesses } = require('./top');

// `cleanup` quits what isn't needed — apps left open with no windows,
// helpers whose app has quit, suspended programs nothing can resume — and
// with -r (memory) or -c (CPU) then lists the biggest remaining users to
// choose from. Only your own programs, never the system's or this shell's
// terminal; apps get a normal Quit, so they can ask to save.

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

// --- what counts as unnecessary ---------------------------------------------------

// Apps people keep open without windows on purpose. Add your own with
// `cleanup --keep NAME` (kept in ~/.maxshell_cleanup_keep).
const KEEP = new Set([
  'Finder', 'Music', 'Spotify', 'Podcasts', 'Mail', 'Messages', 'FaceTime', 'zoom.us', 'Microsoft Teams',
  'Terminal', 'iTerm2', 'Ghostty', 'WezTerm', 'Alacritty', 'kitty', 'Warp', 'Hyper', 'Tabby',
]);

function keepFile() {
  return process.env.MAXSHELL_CLEANUP_KEEP_FILE || require('path').join(os.homedir(), '.maxshell_cleanup_keep');
}

function keepList() {
  const set = new Set(KEEP);
  try {
    for (const line of require('fs').readFileSync(keepFile(), 'utf8').split('\n')) if (line.trim()) set.add(line.trim());
  } catch { /* none added */ }
  return set;
}

// The regular (Dock) apps that are running: [{ name, pid }].
function runningApps() {
  if (process.platform !== 'darwin') return [];
  const r = spawnSync('osascript', ['-e', 'tell application "System Events" to get {name, unix id} of (every application process whose background only is false)'], { encoding: 'utf8', timeout: 5000 });
  const parts = (r.stdout || '').trim().split(', ');
  const half = parts.length / 2;
  if (!Number.isInteger(half)) return [];
  return parts.slice(0, half).map((name, i) => ({ name, pid: Number(parts[half + i]) })).filter((a) => a.pid > 0);
}

// Real windows per process id — on any Space, minimised or not. Menu-bar
// strips, placeholders and tiny helper windows don't count. Read from the
// window server, which needs no special permission.
function windowCounts() {
  if (process.platform !== 'darwin') return null;
  const script = `ObjC.import("CoreGraphics");
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0)));
    const count = {};
    for (const w of list) {
      if (w.kCGWindowLayer !== 0 || !w.kCGWindowBounds) continue;
      const b = w.kCGWindowBounds;
      if (b.Width < 200 || b.Height < 150 || (b.Width === 500 && b.Height === 500)) continue;
      count[w.kCGWindowOwnerPID] = (count[w.kCGWindowOwnerPID] || 0) + 1;
    }
    JSON.stringify(count)`;
  const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 5000 });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Stopped processes and their parents: [{ pid, ppid, stopped }].
function processStates() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat='], { encoding: 'utf8', timeout: 5000 });
  return (r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 3)
    .map(([pid, ppid, stat]) => ({ pid: Number(pid), ppid: Number(ppid), stopped: stat.startsWith('T') }));
}

// Finds what isn't needed: windowless apps, helpers whose app has quit, and
// stopped processes nothing can resume. Returns groups with a reason.
function unnecessary(procs, { apps = [], windows = null, states = [], user = os.userInfo().username, exclude = new Set(), keep = keepList() } = {}) {
  const found = [];
  const taken = new Set();
  const mine = procs.filter((p) => p.user === user && !exclude.has(p.pid) && !PROTECTED.has(p.name));
  const excludedApps = new Set(procs.filter((p) => exclude.has(p.pid)).map((p) => appOf(p.command)).filter(Boolean));

  // 1. Apps that are open but have no windows.
  if (windows) {
    for (const app of apps) {
      if (keep.has(app.name) || PROTECTED.has(app.name) || excludedApps.has(app.name) || exclude.has(app.pid)) continue;
      if (windows[app.pid]) continue;
      const main = procs.find((p) => p.pid === app.pid);
      if (!main || main.user !== user) continue;
      const bundle = appOf(main.command);
      const members = mine.filter((p) => p.pid === app.pid || (bundle && appOf(p.command) === bundle));
      for (const p of members) taken.add(p.pid);
      found.push({
        name: app.name, app: app.name, pids: members.map((p) => p.pid),
        rss: members.reduce((a, p) => a + p.rss, 0), cpu: members.reduce((a, p) => a + p.cpu, 0),
        reason: 'open with no windows',
      });
    }
  }

  // 2. Helpers left behind by an app that has quit (not login items, which
  //    are meant to run on their own).
  const running = new Set(procs.filter((p) => /\.app\/Contents\/MacOS\//.test(p.command)).map((p) => appOf(p.command)));
  const leftovers = new Map();
  for (const p of mine) {
    const app = appOf(p.command);
    if (!app || taken.has(p.pid) || running.has(app) || keep.has(app) || excludedApps.has(app)) continue;
    if (/\/Contents\/MacOS\/|\/LoginItems\/|\/Library\/LaunchAgents\//.test(p.command)) continue;
    // Only apps you installed; macOS's own helpers come and go by design.
    if (!/^(\/Applications\/|\/Users\/[^/]+\/Applications\/)/.test(p.command)) continue;
    let g = leftovers.get(app);
    if (!g) { g = { name: `${app} helpers`, app: null, pids: [], rss: 0, cpu: 0, reason: `${app} isn't running` }; leftovers.set(app, g); }
    g.pids.push(p.pid);
    g.rss += p.rss;
    g.cpu += p.cpu;
    taken.add(p.pid);
  }
  found.push(...leftovers.values());

  // 3. Stopped processes whose shell is gone, so nothing can resume them.
  for (const st of states) {
    if (!st.stopped || st.ppid !== 1 || taken.has(st.pid)) continue;
    const p = mine.find((x) => x.pid === st.pid);
    if (!p) continue;
    found.push({ name: p.name, app: null, pids: [p.pid], rss: p.rss, cpu: p.cpu, reason: 'suspended, and its shell has closed', stopped: true });
  }
  return found;
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
  for (const pid of g.pids) {
    try {
      process.kill(pid, 'SIGTERM');
      if (g.stopped) process.kill(pid, 'SIGCONT');
      ok = true;
    } catch { /* already gone */ }
  }
  return ok;
}

function runCleanup(args, io, shell) {
  const out = (t) => shell.writeTo(io.stdout, t);
  const err = (t) => shell.writeTo(io.stderr, t);
  const t = theme.current();
  const R = ansi.reset();
  const mu = (s) => `${ansi.fg(t.ui.muted)}${s}${R}`;

  // cleanup --keep NAME: never treat NAME as unnecessary.
  if (args[0] === '--keep') {
    const fs = require('fs');
    if (args.length === 1) { for (const k of [...keepList()].sort()) out(`${k}\n`); return 0; }
    fs.appendFileSync(keepFile(), `${args.slice(1).join(' ')}\n`);
    out(`${args.slice(1).join(' ')} will be left alone\n`);
    return 0;
  }
  const flags = args.join('');
  if (args.some((a) => !/^-[rcn]+$/.test(a))) {
    err('usage: cleanup        quit unnecessary processes (windowless apps, leftover helpers)\n'
      + '       cleanup -r     …then free memory: quit what uses the most RAM\n'
      + '       cleanup -c     …then free the CPU: quit what is keeping it busy\n'
      + '       cleanup -n     only show what is unnecessary;   cleanup --keep NAME  never quit NAME\n');
    return 2;
  }
  const kind = /c/.test(flags) ? 'c' : /r/.test(flags) ? 'r' : null;
  const dry = /n/.test(flags);
  let procs = readProcesses();
  if (!procs) { err('cleanup: could not list processes\n'); return 1; }

  // Never touch this shell, its parents (the terminal), or its children.
  const exclude = new Set([process.pid, process.ppid]);
  for (let pid = process.ppid, n = 0; pid > 1 && n < 20; n++) {
    const p = procs.find((x) => x.pid === pid);
    if (!p) break;
    exclude.add(p.pid);
    pid = p.ppid;
  }
  for (const p of procs) if (exclude.has(p.ppid)) exclude.add(p.pid);

  const before = memoryUse();
  if (kind === 'c') out(`CPU    ${meter(cpuUse(), 24)} ${Math.round(cpuUse() * 100)}% busy ${mu(`(load ${os.loadavg()[0].toFixed(2)} on ${os.cpus().length} cores)`)}\n\n`);
  else out(`Memory ${meter(before.used / before.total, 24)} ${humanBytes(before.used)} of ${humanBytes(before.total)} in use\n\n`);

  // First, what isn't needed at all goes without asking.
  const extra = unnecessary(procs, { apps: runningApps(), windows: windowCounts(), states: processStates(), exclude });
  if (extra.length) {
    out(dry ? 'Unnecessary (cleanup without -n quits these):\n' : 'Quitting what isn’t needed:\n');
    const nameW = Math.min(30, Math.max(...extra.map((g) => g.name.length)) + 2);
    for (const g of extra) {
      const size = humanBytes(g.rss).padStart(7);
      const mark = dry ? mu('·') : quit(g) ? `${ansi.fg(t.ui.ok)}✓${R}` : `${ansi.fg(t.ui.err)}✗${R}`;
      out(`  ${mark} ${fit(g.name, nameW)}${size}   ${mu(g.reason)}\n`);
    }
    if (!dry) out(mu('  (cleanup --keep NAME leaves an app alone next time)\n'));
    out('\n');
  } else {
    out(`${ansi.fg(t.ui.ok)}✓${R} nothing unnecessary is running\n\n`);
  }

  // Then, with -r or -c, the biggest remaining users, to choose from.
  if (kind) {
    const gone = new Set(dry ? [] : extra.flatMap((g) => g.pids));
    if (gone.size) { spawnSync('sleep', ['1']); procs = readProcesses() || procs; }
    const list = hogs(procs.filter((p) => !gone.has(p.pid)), { kind, exclude });
    if (list.length) {
      out(kind === 'r' ? 'Using the most memory:\n' : 'Keeping the CPU busy:\n');
      const nameW = Math.min(32, Math.max(...list.map((g) => g.name.length)) + 2);
      list.forEach((g, i) => {
        const amount = kind === 'r' ? humanBytes(g.rss).padStart(8) : `${g.cpu.toFixed(1)}%`.padStart(7);
        const more = g.pids.length > 1 ? mu(`${g.pids.length} processes`) : mu(`pid ${g.pids[0]}`);
        out(`  ${ansi.fg(t.ui.accent)}${String(i + 1).padStart(2)}${R}  ${fit(g.name, nameW)}${amount}   ${more}\n`);
      });
      if (!dry && process.stdin.isTTY && io.stdin.kind === 'term') {
        out(`\nQuit any of these too? ${mu('numbers like 1 3 or 2-4, "all", or Enter for none')} `);
        for (const i of parseChoice(shell.readLine(io.stdin) || '', list.length)) {
          const g = list[i];
          out(`${quit(g) ? `${ansi.fg(t.ui.ok)}✓${R} quit` : `${ansi.fg(t.ui.err)}✗${R} could not quit`} ${g.name}\n`);
        }
      }
    }
  }

  if (!dry && (extra.length || kind === 'r')) {
    spawnSync('sleep', ['1.5']);
    const after = memoryUse();
    const freed = before.used - after.used;
    out(`\nMemory ${meter(after.used / after.total, 24)} ${humanBytes(after.used)} in use`
      + `${freed > 0 ? ` ${ansi.fg(t.ui.ok)}(${humanBytes(freed)} freed)${R}` : ''}\n`);
  }
  return 0;
}

module.exports = { runCleanup, hogs, parseChoice, appOf, unnecessary, PROTECTED, KEEP };
