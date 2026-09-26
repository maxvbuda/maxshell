'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const { textWidth, humanBytes } = require('./tui');

// A modern `ls` (in the spirit of eza/lsd): icons, colour by kind, folders
// first, git status per file, a long view and a tree. It only takes over
// when you run `ls` yourself at a terminal with options it understands;
// scripts, pipes and unfamiliar flags get the real `ls`, unchanged.

const SUPPORTED = new Set(['a', 'A', 'l', 'h', '1', 't', 'S', 'r', 'T', 'R']);

function parseArgs(args) {
  const opts = { all: false, almostAll: false, long: false, one: false, sort: 'name', reverse: false, tree: false, level: 3 };
  const paths = [];
  for (const a of args) {
    if (a === '--') continue;
    if (a === '--tree') { opts.tree = true; continue; }
    const lvl = /^--level=(\d+)$/.exec(a);
    if (lvl) { opts.level = Number(lvl[1]); continue; }
    if (a.startsWith('--')) return null;
    if (a.startsWith('-') && a.length > 1) {
      for (const f of a.slice(1)) {
        if (!SUPPORTED.has(f)) return null;
        if (f === 'a') opts.all = true;
        else if (f === 'A') opts.almostAll = true;
        else if (f === 'l') opts.long = true;
        else if (f === '1') opts.one = true;
        else if (f === 't') opts.sort = 'time';
        else if (f === 'S') opts.sort = 'size';
        else if (f === 'r') opts.reverse = true;
        else if (f === 'T' || f === 'R') opts.tree = true;
      }
      continue;
    }
    paths.push(a);
  }
  return { opts, paths };
}

function readDir(dir, opts) {
  const { describe } = require('./files');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { error: e.code || e.message }; }
  const showHidden = opts.all || opts.almostAll;
  const entries = [];
  for (const name of names) {
    if (!showHidden && name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let lst = null;
    let st = null;
    try { lst = fs.lstatSync(full); } catch { continue; }
    try { st = fs.statSync(full); } catch { /* broken link */ }
    const isDir = !!st && st.isDirectory();
    const e = {
      name, path: full, isDir, isLink: lst.isSymbolicLink(), broken: lst.isSymbolicLink() && !st,
      size: st ? st.size : lst.size, mtime: (st || lst).mtimeMs, mode: lst.mode,
      exec: !!st && st.isFile() && (st.mode & 0o111) !== 0, hidden: name.startsWith('.'),
    };
    e.icon = describe(e).icon;
    entries.push(e);
  }
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
    time: (a, b) => b.mtime - a.mtime,
    size: (a, b) => b.size - a.size,
  }[opts.sort];
  entries.sort((a, b) => (a.isDir === b.isDir ? cmp(a, b) || a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  if (opts.reverse) entries.reverse();
  return { entries };
}

// Git status of everything under `dir`, keyed by absolute path; folders get
// the most notable status of anything inside them.
function gitStatus(dir) {
  const res = spawnSync('git', ['-C', dir, 'status', '--porcelain=1', '-z', '--untracked-files=all', '.'], {
    encoding: 'utf8', timeout: 1500, maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return null;
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 800 });
  if (top.status !== 0) return null;
  const root = fs.realpathSync(top.stdout.trim());
  const map = new Map();
  const rank = { '?': 1, M: 3, D: 3, A: 2, R: 2, U: 4 };
  const records = res.stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const file = rec.slice(3);
    if (x === 'R' || x === 'C') i++; // the next record is the old name
    const mark = x === '?' ? '?' : (y !== ' ' ? y : x);
    let p = path.join(root, file);
    // Mark the file and every folder on the way up to `dir`.
    while (p.length >= dir.length) {
      const prev = map.get(p);
      if (!prev || (rank[mark] || 0) > (rank[prev] || 0)) map.set(p, mark);
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
  }
  return map;
}

function gitMark(mark) {
  const { ui } = theme.current();
  switch (mark) {
    case '?': return `${ansi.fg(ui.accent2)}N${ansi.reset()}`;
    case 'M': return `${ansi.fg(ui.warn)}M${ansi.reset()}`;
    case 'A': return `${ansi.fg(ui.ok)}+${ansi.reset()}`;
    case 'D': return `${ansi.fg(ui.err)}D${ansi.reset()}`;
    case 'R': return `${ansi.fg(ui.accent)}R${ansi.reset()}`;
    case 'U': return `${ansi.fg(ui.err)}U${ansi.reset()}`;
    default: return ' ';
  }
}

function paintName(e) {
  const { ui } = theme.current();
  const R = ansi.reset();
  let color = '';
  if (e.broken) color = ansi.fg(ui.err);
  else if (e.isDir) color = ansi.bold() + ansi.fg(ui.dir);
  else if (e.isLink) color = ansi.fg(ui.accent);
  else if (e.exec) color = ansi.fg(ui.ok);
  else if (e.hidden) color = ansi.fg(ui.muted);
  const suffix = e.isDir ? '/' : '';
  return `${e.icon} ${color}${e.name}${suffix}${R}`;
}

const cellWidth = (e) => textWidth(e.icon) + 1 + textWidth(e.name) + (e.isDir ? 1 : 0);

// Column-major grid, as ls lays it out, using as many columns as fit.
function grid(entries, cols) {
  if (!entries.length) return [];
  const widths = entries.map(cellWidth);
  const gap = 2;
  for (let ncol = Math.min(entries.length, Math.floor(cols / 3)); ncol >= 1; ncol--) {
    const nrow = Math.ceil(entries.length / ncol);
    const colW = [];
    for (let c = 0; c < ncol; c++) {
      let w = 0;
      for (let r = 0; r < nrow; r++) { const i = c * nrow + r; if (i < entries.length) w = Math.max(w, widths[i]); }
      colW.push(w);
    }
    const total = colW.reduce((s, w) => s + w, 0) + gap * (ncol - 1);
    if (total <= cols || ncol === 1) {
      const lines = [];
      for (let r = 0; r < nrow; r++) {
        let line = '';
        for (let c = 0; c < ncol; c++) {
          const i = c * nrow + r;
          if (i >= entries.length) break;
          const last = c === ncol - 1 || (c + 1) * nrow + r >= entries.length;
          line += paintName(entries[i]) + (last ? '' : ' '.repeat(colW[c] - widths[i] + gap));
        }
        lines.push(line);
      }
      return lines;
    }
  }
  return entries.map(paintName);
}

function permissions(mode, isDir, isLink) {
  const { ui } = theme.current();
  const R = ansi.reset();
  const kind = isLink ? `${ansi.fg(ui.accent)}l${R}` : isDir ? `${ansi.fg(ui.dir)}d${R}` : `${ansi.fg(ui.muted)}.${R}`;
  const bits = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'].map((c, i) => {
    if (!((mode >> (8 - i)) & 1)) return `${ansi.fg(ui.muted)}-${R}`;
    const color = c === 'r' ? ui.warn : c === 'w' ? ui.err : ui.ok;
    return `${ansi.fg(color)}${c}${R}`;
  }).join('');
  return kind + bits;
}

function when(ms) {
  const { ago } = require('./history');
  const age = Date.now() - ms;
  if (age < 14 * 86400000) return ago(ms);
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function longView(entries, git) {
  const { ui } = theme.current();
  const R = ansi.reset();
  const sizes = entries.map((e) => (e.isDir ? '-' : humanBytes(e.size)));
  const dates = entries.map((e) => when(e.mtime));
  const sw = Math.max(4, ...sizes.map((s) => s.length));
  const dw = Math.max(8, ...dates.map((d) => d.length));
  const head = `${ansi.fg(ui.muted)}${'Permissions'.padEnd(11)} ${'Size'.padStart(sw)}  ${'Modified'.padEnd(dw)}${git ? '  Git' : ''}  Name${R}`;
  const lines = [head];
  entries.forEach((e, i) => {
    let name = paintName(e);
    if (e.isLink) {
      let target = '?';
      try { target = fs.readlinkSync(e.path); } catch { /* unreadable */ }
      name += ` ${ansi.fg(ui.muted)}→ ${target}${R}`;
    }
    const size = e.isDir ? `${ansi.fg(ui.muted)}${sizes[i].padStart(sw)}${R}` : `${ansi.fg(ui.ok)}${sizes[i].padStart(sw)}${R}`;
    // The mark sits under the middle of "Git".
    const mark = git ? `   ${gitMark(git.get(e.path))} ` : '';
    lines.push(`${permissions(e.mode, e.isDir, e.isLink)}  ${size}  ${ansi.fg(ui.accent)}${dates[i].padEnd(dw)}${R}${mark} ${name}`);
  });
  return lines;
}

function tree(dir, opts, git, limit = { left: 1000 }) {
  const { ui } = theme.current();
  const R = ansi.reset();
  const lines = [];
  const SKIP = new Set(['.git', 'node_modules']);
  const walk = (d, prefix, depth) => {
    if (depth > opts.level || limit.left <= 0) return;
    const { entries = [] } = readDir(d, opts);
    const visible = entries.filter((e) => !(SKIP.has(e.name) && !opts.all));
    visible.forEach((e, i) => {
      if (limit.left-- <= 0) return;
      const last = i === visible.length - 1;
      const mark = git && git.get(e.path) ? ` ${gitMark(git.get(e.path))}` : '';
      lines.push(`${ansi.fg(ui.muted)}${prefix}${last ? '└── ' : '├── '}${R}${paintName(e)}${mark}`);
      if (e.isDir && !e.isLink) walk(e.path, `${prefix}${last ? '    ' : '│   '}`, depth + 1);
    });
  };
  walk(dir, '', 1);
  if (limit.left <= 0) lines.push(`${ansi.fg(ui.muted)}… (stopped after 1000 entries; --level=N limits depth)${R}`);
  return lines;
}

// Renders `ls` output for `paths` as lines, or null if the real ls should run.
function render(args, cwd, cols) {
  const parsed = parseArgs(args);
  if (!parsed) return null;
  const { opts } = parsed;
  const paths = parsed.paths.length ? parsed.paths : ['.'];
  const out = [];
  let status = 0;

  paths.forEach((p, idx) => {
    const full = path.resolve(cwd, p.replace(/^~(?=$|\/)/, require('os').homedir()));
    let st;
    try { st = fs.statSync(full); } catch {
      out.push(`${ansi.fg(theme.current().ui.err)}ls: ${p}: no such file or directory${ansi.reset()}`);
      status = 1;
      return;
    }
    if (paths.length > 1 && st.isDirectory()) out.push(`${idx ? '\n' : ''}${ansi.bold()}${p}:${ansi.reset()}`);
    if (!st.isDirectory()) {
      const { describe } = require('./files');
      const e = { name: p, path: full, isDir: false, size: st.size, mtime: st.mtimeMs, mode: st.mode, exec: (st.mode & 0o111) !== 0 };
      e.icon = describe(e).icon;
      out.push(...(opts.long ? longView([e], null).slice(1) : [paintName(e)]));
      return;
    }
    const git = (opts.long || opts.tree) ? gitStatus(full) : null;
    if (opts.tree) {
      out.push(`${ansi.bold()}${p}${ansi.reset()}`, ...tree(full, opts, git));
      return;
    }
    const { entries, error } = readDir(full, opts);
    if (error) { out.push(`ls: ${p}: ${error}`); status = 1; return; }
    if (opts.long) out.push(...longView(entries, git));
    else if (opts.one) out.push(...entries.map(paintName));
    else out.push(...grid(entries, cols));
  });
  return { lines: out, status };
}

module.exports = { render, parseArgs, grid, gitStatus, readDir };
