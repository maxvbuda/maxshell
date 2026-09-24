'use strict';

const ansi = require('./ansi');

// Shared plumbing for maxshell's full-screen tools.

function requireTty(name, io, shell) {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  shell.writeTo(io.stderr, `${name}: needs an interactive terminal\n`);
  return false;
}

// Runs `fn` on the alternate screen in raw mode, restoring the terminal even
// if `fn` throws.
function fullscreen(fn, { cursor = true } = {}) {
  const wasRaw = process.stdin.isRaw;
  try {
    process.stdin.setRawMode(true);
    process.stdout.write(`\x1b[?1049h${cursor ? '\x1b[?25h' : '\x1b[?25l'}`);
    return fn();
  } finally {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    try { process.stdin.setRawMode(!!wasRaw); } catch { /* not a tty any more */ }
  }
}

// Truncates or pads plain text to exactly `width` columns.
function fit(text, width) {
  const chars = [...String(text)];
  if (chars.length > width) return `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
  return chars.join('') + ' '.repeat(width - chars.length);
}

// A full-width reverse-video bar.
function bar(text, cols) {
  return `${ansi.reverse()}${fit(text, cols)}${ansi.reset()}`;
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

// A horizontal meter: [|||||     ] 42%
function meter(fraction, width) {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const inner = Math.max(1, width - 2);
  const filled = Math.round(f * inner);
  const color = f > 0.85 ? ansi.fg('red') : f > 0.6 ? ansi.fg('yellow') : ansi.fg('green');
  return `[${color}${'|'.repeat(filled)}${ansi.reset()}${' '.repeat(inner - filled)}]`;
}

module.exports = { requireTty, fullscreen, fit, bar, humanBytes, meter };
