'use strict';

const os = require('os');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const { fit, textWidth, bar, meter, humanBytes, fullscreen, requireTty } = require('./tui');
const { KeyReader } = require('./keys');
const { coreUsage, readProcesses } = require('./top');

// `dash`: one live screen with what you'd otherwise check with five
// commands — this project and its git state, running jobs, the machine's
// CPU, memory and battery, the busiest processes, and what you ran here
// recently. A key opens the matching tool.

const REFRESH_MS = 1500;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 1500 });
  return r.status === 0 ? r.stdout : '';
}

class DashModel {
  constructor(shell, { sample = true } = {}) {
    this.shell = shell;
    this.sample = sample;
    this.prevCpus = null;
    this.cores = [];
    this.procs = [];
    this.gitSlow = 0;
  }

  refresh() {
    const shell = this.shell;
    const cwd = shell.cwd;

    // Git: branch, sync, changes, recent commits (the slow bits less often).
    const status = run('git', ['status', '--porcelain=2', '--branch'], cwd);
    this.git = null;
    if (status) {
      const g = { branch: '?', ahead: 0, behind: 0, staged: 0, changed: 0, untracked: 0, commits: [] };
      for (const line of status.split('\n')) {
        if (line.startsWith('# branch.head ')) g.branch = line.slice(14);
        else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { g.ahead = +m[1]; g.behind = +m[2]; } } else if (/^[12u] /.test(line)) {
          const xy = line.split(' ')[1];
          if (xy[0] !== '.') g.staged++;
          if (xy[1] !== '.') g.changed++;
        } else if (line.startsWith('? ')) g.untracked++;
      }
      if (!this.commits || Date.now() - this.gitSlow > 10000) {
        this.commits = run('git', ['log', '-5', '--format=%h\t%s\t%cr'], cwd).split('\n').filter(Boolean).map((l) => l.split('\t'));
        this.gitSlow = Date.now();
      }
      g.commits = this.commits;
      this.git = g;
    }

    const { promptModules } = require('./context');
    try { this.modules = promptModules(shell).map((m) => m.text); } catch { this.modules = []; }

    // Machine.
    const now = os.cpus();
    this.cores = coreUsage(this.prevCpus, now);
    this.prevCpus = now;
    this.mem = { total: os.totalmem(), used: os.totalmem() - os.freemem() };
    if (process.platform === 'darwin') {
      // macOS counts cache as used; vm_stat's free + inactive is closer to what's available.
      const vm = run('vm_stat', []);
      const page = Number((/page size of (\d+)/.exec(vm) || [])[1]) || 16384;
      const pages = (k) => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(vm) || [])[1]) || 0;
      if (vm) this.mem.used = this.mem.total - (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page;
      const batt = run('pmset', ['-g', 'batt']);
      const m = /(\d+)%;\s*([^;]+);/.exec(batt);
      this.battery = m ? { pct: Number(m[1]), state: m[2].trim() } : null;
    }
    this.load = os.loadavg();
    this.uptime = os.uptime();

    if (this.sample) {
      const procs = readProcesses() || [];
      this.procs = procs.sort((a, b) => b.cpu - a.cpu).slice(0, 6);
    }

    // Jobs and recent commands (this folder first).
    this.jobs = (shell.jobs || []).map((j) => { j.poll(); return { id: j.id, state: j.state, cmd: j.cmd }; });
    this.recent = [];
    try {
      const { History, historyFile } = require('./history');
      const h = new History().load(historyFile(), 2000);
      const seen = new Set();
      for (let i = h.entries.length - 1; i >= 0 && this.recent.length < 6; i--) {
        const e = h.entries[i];
        if (e.cwd !== cwd || seen.has(e.cmd) || e.cmd.includes('\n')) continue;
        seen.add(e.cmd);
        this.recent.push({ cmd: e.cmd, ts: e.ts });
      }
    } catch { /* no history */ }
    this.at = new Date();
  }
}

// --- the screen -------------------------------------------------------------

class DashScreen {
  constructor(model) {
    this.model = model;
    this.done = false;
    this.action = null;
  }

  // A titled panel of `width` columns: [title line, ...body lines].
  panel(title, lines, width) {
    const t = theme.current();
    const R = ansi.reset();
    const head = `${ansi.fg(t.ui.accent)}${ansi.bold()}${fit(` ${title}`, width)}${R}`;
    return [head, ...lines.map((l) => fitAnsi(l, width))];
  }

  render(cols, rows) {
    const m = this.model;
    const t = theme.current();
    const R = ansi.reset();
    const mu = (s) => `${ansi.fg(t.ui.muted)}${s}${R}`;
    const home = os.homedir();
    const where = m.shell.cwd === home ? '~' : m.shell.cwd.startsWith(`${home}/`) ? `~${m.shell.cwd.slice(home.length)}` : m.shell.cwd;
    const out = [bar(` dash  ${where}${' '.repeat(3)}${m.at ? m.at.toTimeString().slice(0, 8) : ''}`, cols)];

    const two = cols >= 96;
    const colW = two ? Math.floor((cols - 3) / 2) : cols - 2;

    // Project.
    const proj = [];
    if (m.git) {
      const g = m.git;
      const sync = [g.ahead && `↑${g.ahead}`, g.behind && `↓${g.behind}`].filter(Boolean).join(' ') || 'in sync';
      proj.push(`${theme.style(t.prompt.branch)}⎇ ${g.branch}${R}  ${mu(sync)}`);
      const counts = [
        g.staged && `${ansi.fg(t.ui.ok)}${g.staged} staged${R}`,
        g.changed && `${ansi.fg(t.ui.warn)}${g.changed} changed${R}`,
        g.untracked && `${ansi.fg(t.ui.muted)}${g.untracked} untracked${R}`,
      ].filter(Boolean);
      proj.push(counts.length ? counts.join(mu(' · ')) : `${ansi.fg(t.ui.ok)}✓ clean${R}`);
      for (const [hash, subject, when] of g.commits) proj.push(`${ansi.fg(t.ui.accent2)}${hash}${R} ${subject} ${mu(when)}`);
    } else proj.push(mu('not a git repository'));
    if (m.modules && m.modules.length) proj.push(mu(m.modules.join(' · ')));

    // Machine.
    const sys = [];
    const meterW = Math.max(6, Math.min(24, colW - 18));
    const avg = m.cores.length ? m.cores.reduce((a, b) => a + b, 0) / m.cores.length : 0;
    sys.push(`CPU  ${meter(avg, meterW)} ${fit(`${Math.round(avg * 100)}%`, 5)}${mu(`${m.cores.length} cores`)}`);
    const memFrac = m.mem ? m.mem.used / m.mem.total : 0;
    sys.push(`Mem  ${meter(memFrac, meterW)} ${fit(`${Math.round(memFrac * 100)}%`, 5)}${mu(m.mem ? `${humanBytes(m.mem.used)} of ${humanBytes(m.mem.total)}` : '')}`);
    if (m.battery) sys.push(`Batt ${meter(m.battery.pct / 100, meterW)} ${fit(`${m.battery.pct}%`, 5)}${mu(m.battery.state)}`);
    if (m.load) sys.push(mu(`load ${m.load.map((x) => x.toFixed(2)).join(' ')} · up ${formatUptime(m.uptime)}`));
    for (const p of m.procs.slice(0, 4)) {
      const name = p.name || String(p.pid);
      sys.push(`${fit(`${(p.cpu ?? 0).toFixed(1)}%`, 7)}${fit(name, Math.max(4, colW - 7))}`);
    }

    // Jobs and recent commands.
    const jobs = m.jobs.length
      ? m.jobs.map((j) => `[${j.id}] ${j.state === 'stopped' ? `${ansi.fg(t.ui.warn)}suspended${R}` : j.state === 'running' ? `${ansi.fg(t.ui.ok)}running${R}` : mu('done')}  ${j.cmd}`)
      : [mu('no jobs — Ctrl-Z suspends a program, & runs one in the background')];
    const { ago } = require('./history');
    const recent = m.recent.length ? m.recent.map((r) => `${r.cmd}  ${mu(ago(r.ts))}`) : [mu('nothing run in this folder yet')];

    const blocks = [
      this.panel('Project', proj, colW), this.panel('Machine', sys, colW),
      this.panel('Jobs', jobs, colW), this.panel('Recent here', recent, colW),
    ];
    const body = [];
    if (two) {
      for (let b = 0; b < blocks.length; b += 2) {
        const left = blocks[b];
        const right = blocks[b + 1] || [];
        const h = Math.max(left.length, right.length);
        for (let i = 0; i < h; i++) body.push(` ${fitAnsi(left[i] || '', colW)} ${fitAnsi(right[i] || '', colW)}`);
        body.push('');
      }
    } else {
      for (const b of blocks) { for (const l of b) body.push(` ${l}`); body.push(''); }
    }
    for (const l of body.slice(0, rows - 2)) out.push(l);
    while (out.length < rows - 1) out.push('');
    out.push(bar(' g gitui · f files · t top · e edit · j jobs · p palette · r refresh · q quit', cols));
    return out.slice(0, rows);
  }

  handleKey(key) {
    const acts = { g: 'gitui', f: 'files', t: 'top', e: 'edit', j: 'jobs', p: 'palette' };
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.done = true; return; }
    if (key.name === 'r') { this.model.refresh(); return; }
    if (acts[key.name]) { this.action = acts[key.name]; this.done = true; }
  }

  loop() {
    const reader = new KeyReader(0);
    this.model.refresh();
    let last = Date.now();
    const draw = () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      process.stdout.write(`\x1b[H${this.render(cols, rows).map((l) => `${l}${ansi.reset()}\x1b[K`).join('\r\n')}\x1b[J`);
    };
    draw();
    while (!this.done) {
      const key = reader.next(REFRESH_MS);
      if (key.name === 'eof') break;
      if (key.name !== 'timeout') this.handleKey(key);
      if (this.done) break;
      if (Date.now() - last >= REFRESH_MS) { this.model.refresh(); last = Date.now(); }
      draw();
    }
    return this.action;
  }
}

// Pads or cuts text that contains colour codes to exactly `width` columns.
function fitAnsi(text, width) {
  const plain = ansi.strip(text);
  const w = textWidth(plain);
  if (w <= width) return text + ' '.repeat(width - w);
  return fit(plain, width);
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function runDash(args, io, shell) {
  if (!requireTty('dash', io, shell)) return 1;
  const screen = new DashScreen(new DashModel(shell));
  const action = fullscreen(() => screen.loop(), { cursor: false });
  // Leaving through a tool's key opens that tool.
  if (action) return shell.runSource(action, io);
  return 0;
}

module.exports = { DashModel, DashScreen, runDash, fitAnsi };
