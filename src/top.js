'use strict';

const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const { KeyReader } = require('./keys');
const { fullscreen, requireTty, bar, fit, humanBytes, meter } = require('./tui');

const REFRESH_MS = 1500;

// --- reading processes ------------------------------------------------------

// Parses `ps -A -o pid=,ppid=,pcpu=,pmem=,rss=,user=,args=` output.
function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[7].trim();
    const exe = command.split(/\s+/)[0] || '';
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      mem: Number(m[4]),
      rss: Number(m[5]) * 1024,
      user: m[6],
      command,
      name: path.basename(exe) || exe,
    });
  }
  return rows;
}

function readProcesses() {
  const res = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pcpu=,pmem=,rss=,user=,args='], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5000,
  });
  if (res.error || res.status !== 0) return null;
  return parsePs(res.stdout);
}

// Per-core busy fraction between two os.cpus() samples.
function coreUsage(before, after) {
  return after.map((cpu, i) => {
    const prev = before && before[i];
    if (!prev) return 0;
    const total = (t) => t.user + t.nice + t.sys + t.idle + t.irq;
    const dTotal = total(cpu.times) - total(prev.times);
    const dIdle = cpu.times.idle - prev.times.idle;
    return dTotal > 0 ? Math.max(0, Math.min(1, 1 - dIdle / dTotal)) : 0;
  });
}

// --- the model --------------------------------------------------------------

const SORTS = {
  cpu: (a, b) => b.cpu - a.cpu || b.mem - a.mem,
  mem: (a, b) => b.rss - a.rss || b.cpu - a.cpu,
  pid: (a, b) => a.pid - b.pid,
  name: (a, b) => a.name.localeCompare(b.name) || a.pid - b.pid,
};

class ProcessTable {
  constructor() {
    this.all = [];
    this.sortKey = 'cpu';
    this.filter = '';
    this.cursor = 0;
    this.top = 0;
    this.selectedPid = null;
  }

  // Replaces the data, keeping the same process selected if it still exists.
  update(rows) {
    this.all = rows;
    const list = this.visible();
    if (this.selectedPid !== null) {
      const at = list.findIndex((p) => p.pid === this.selectedPid);
      if (at !== -1) this.cursor = at;
    }
    this.clamp();
  }

  visible() {
    const needle = this.filter.toLowerCase();
    const list = needle
      ? this.all.filter((p) => p.command.toLowerCase().includes(needle)
        || p.user.toLowerCase().includes(needle) || String(p.pid) === needle)
      : this.all.slice();
    return list.sort(SORTS[this.sortKey]);
  }

  get current() { return this.visible()[this.cursor] || null; }

  clamp() {
    const n = this.visible().length;
    this.cursor = n ? Math.max(0, Math.min(n - 1, this.cursor)) : 0;
    this.selectedPid = this.current ? this.current.pid : null;
  }

  move(n) { this.cursor += n; this.clamp(); }

  setSort(key) {
    if (!SORTS[key]) return;
    this.sortKey = key;
    const list = this.visible();
    const at = this.selectedPid === null ? -1 : list.findIndex((p) => p.pid === this.selectedPid);
    this.cursor = at === -1 ? 0 : at;
    this.clamp();
  }

  setFilter(text) {
    this.filter = text;
    this.cursor = 0;
    this.clamp();
  }

  scroll(height) {
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + height) this.top = this.cursor - height + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.visible().length - height)));
  }

  totals() {
    return {
      count: this.all.length,
      cpu: this.all.reduce((s, p) => s + p.cpu, 0),
    };
  }
}

// --- the screen -------------------------------------------------------------

const HELP = '↑↓ select  c m p n sort  / filter  k kill  K force-kill  r refresh  q quit';

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

class TopScreen {
  constructor(table, { output = process.stdout, read = readProcesses } = {}) {
    this.table = table;
    this.output = output;
    this.read = read;
    this.prevCpus = os.cpus();
    this.cores = this.prevCpus.map(() => 0);
    this.prompt = null;
    this.filtering = false;
    this.message = '';
    this.done = false;
  }

  get rows() { return this.output.rows || 24; }

  get cols() { return this.output.columns || 80; }

  refresh() {
    const rows = this.read();
    if (rows) this.table.update(rows);
    else this.message = 'could not run ps';
    const now = os.cpus();
    this.cores = coreUsage(this.prevCpus, now);
    this.prevCpus = now;
  }

  header() {
    const lines = [];
    const cols = this.cols;
    const perRow = cols >= 100 ? 4 : cols >= 60 ? 2 : 1;
    const cellW = Math.floor(cols / perRow);
    for (let i = 0; i < this.cores.length; i += perRow) {
      let line = '';
      for (let j = i; j < Math.min(i + perRow, this.cores.length); j++) {
        const label = `${String(j).padStart(2)} `;
        const pct = ` ${String(Math.round(this.cores[j] * 100)).padStart(3)}%`;
        line += label + meter(this.cores[j], Math.max(4, cellW - label.length - pct.length - 1)) + pct + ' ';
      }
      lines.push(line);
    }

    const total = os.totalmem();
    const used = total - os.freemem();
    const memLabel = 'Mem ';
    const memText = ` ${humanBytes(used)}/${humanBytes(total)}`;
    lines.push(memLabel + meter(used / total, Math.max(10, Math.floor(cols / 2) - memLabel.length - memText.length)) + memText);

    const load = os.loadavg().map((n) => n.toFixed(2)).join(' ');
    const { count } = this.table.totals();
    lines.push(`${ansi.fg('gray')}Tasks ${ansi.reset()}${count}   ${ansi.fg('gray')}Load ${ansi.reset()}${load}   ${ansi.fg('gray')}Up ${ansi.reset()}${formatUptime(os.uptime())}   ${ansi.fg('gray')}Sort ${ansi.reset()}${this.table.sortKey}${this.table.filter ? `   ${ansi.fg('gray')}Filter ${ansi.reset()}${this.table.filter}` : ''}`);
    return lines;
  }

  render() {
    const t = this.table;
    const head = this.header();
    const listH = Math.max(1, this.rows - head.length - 3);
    t.scroll(listH);

    let s = '\x1b[H';
    s += head.map((l) => `${l}\x1b[K`).join('\r\n');

    const cmdW = Math.max(10, this.cols - 42);
    const columns = `${'PID'.padStart(7)} ${fit('USER', 10)} ${'CPU%'.padStart(6)} ${'MEM%'.padStart(5)} ${'RSS'.padStart(6)}  ${fit('COMMAND', cmdW)}`;
    s += `\r\n${bar(columns, this.cols)}`;

    const list = t.visible();
    for (let i = 0; i < listH; i++) {
      s += '\r\n';
      const p = list[t.top + i];
      if (!p) { s += '\x1b[K'; continue; }
      const cpuColor = p.cpu > 50 ? ansi.fg('red') : p.cpu > 10 ? ansi.fg('yellow') : '';
      const row = `${String(p.pid).padStart(7)} ${fit(p.user, 10)} ${p.cpu.toFixed(1).padStart(6)} ${p.mem.toFixed(1).padStart(5)} ${humanBytes(p.rss).padStart(6)}  ${fit(p.command, cmdW)}`;
      if (t.top + i === t.cursor) s += `${ansi.reverse()}${fit(row, this.cols)}${ansi.reset()}`;
      else s += `${cpuColor}${fit(row, this.cols)}${ansi.reset()}`;
    }

    s += '\r\n';
    if (this.prompt) s += `${ansi.fg(214)}${this.prompt.label}${ansi.reset()}${this.prompt.value}\x1b[K`;
    else if (this.filtering) s += `/${t.filter}\x1b[K`;
    else if (this.message) s += `${ansi.fg(214)}${this.message}${ansi.reset()}\x1b[K`;
    else s += `${ansi.fg('gray')}${HELP}${ansi.reset()}\x1b[K`;
    this.output.write(s);
  }

  askKill(signal) {
    const p = this.table.current;
    if (!p) return;
    if (p.pid === process.pid) { this.message = "that's maxshell itself"; return; }
    this.prompt = {
      label: `send ${signal} to ${p.pid} (${p.name})? (y/n) `,
      value: '',
      onDone: (answer) => {
        if (!/^y(es)?$/i.test(answer.trim())) { this.message = 'cancelled'; return; }
        try {
          process.kill(p.pid, signal);
          this.message = `sent ${signal} to ${p.pid}`;
        } catch (e) {
          this.message = e.code === 'EPERM' ? `not allowed to signal ${p.pid}` : `${p.pid}: ${e.code || e.message}`;
        }
        this.refresh();
      },
    };
  }

  handleKey(key) {
    const t = this.table;
    if (key.name === 'eof') { this.done = true; return; }

    if (this.prompt) {
      const pr = this.prompt;
      if (key.name === 'return') { this.prompt = null; pr.onDone(pr.value); return; }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { this.prompt = null; this.message = 'cancelled'; return; }
      if (key.name === 'backspace') { pr.value = pr.value.slice(0, -1); return; }
      if (key.printable) pr.value += key.str;
      return;
    }

    if (this.filtering) {
      if (key.name === 'return') { this.filtering = false; return; }
      if (key.name === 'escape') { this.filtering = false; t.setFilter(''); return; }
      if (key.name === 'backspace') { t.setFilter(t.filter.slice(0, -1)); return; }
      if (key.printable) t.setFilter(t.filter + key.str);
      return;
    }

    this.message = '';
    if (key.ctrl && key.name === 'c') { this.done = true; return; }
    const page = Math.max(1, this.rows - 8);
    switch (key.name) {
      case 'q': case 'Q': case 'escape': this.done = true; break;
      // Arrows only: k is kill, as in htop.
      case 'up': t.move(-1); break;
      case 'down': t.move(1); break;
      case 'pageup': t.move(-page); break;
      case 'pagedown': case ' ': case 'space': t.move(page); break;
      case 'g': case 'home': t.move(-Infinity); break;
      case 'G': case 'end': t.move(Infinity); break;
      case 'c': t.setSort('cpu'); break;
      case 'm': t.setSort('mem'); break;
      case 'p': t.setSort('pid'); break;
      case 'n': t.setSort('name'); break;
      case '/': this.filtering = true; break;
      case 'k': this.askKill('SIGTERM'); break;
      case 'K': this.askKill('SIGKILL'); break;
      case 'r': this.refresh(); break;
      default: break;
    }
  }

  loop() {
    const reader = new KeyReader(0);
    this.refresh();
    this.render();
    let last = Date.now();
    while (!this.done) {
      const key = reader.next(REFRESH_MS);
      if (key.name !== 'timeout') this.handleKey(key);
      // Keep sampling on schedule even while keys are arriving, but not
      // while a question is on screen.
      if (!this.prompt && Date.now() - last >= REFRESH_MS) {
        this.refresh();
        last = Date.now();
      }
      if (!this.done) this.render();
    }
    return 0;
  }
}

function runTop(args, io, shell) {
  if (!requireTty('top', io, shell)) return 1;
  const table = new ProcessTable();
  const sort = args.find((a) => a.startsWith('--sort='));
  if (sort) table.setSort(sort.slice('--sort='.length));
  return fullscreen(() => new TopScreen(table).loop(), { cursor: false });
}

module.exports = { ProcessTable, TopScreen, parsePs, coreUsage, readProcesses, runTop };
