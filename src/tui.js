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
// Asks the terminal to report clicks and the scroll wheel as SGR sequences.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

function fullscreen(fn, { cursor = true, mouse = false } = {}) {
  const wasRaw = process.stdin.isRaw;
  try {
    process.stdin.setRawMode(true);
    process.stdout.write(`\x1b[?1049h${cursor ? '\x1b[?25h' : '\x1b[?25l'}${mouse ? MOUSE_ON : ''}`);
    return fn();
  } finally {
    process.stdout.write(`${mouse ? MOUSE_OFF : ''}\x1b[?25h\x1b[?1049l`);
    try { process.stdin.setRawMode(!!wasRaw); } catch { /* not a tty any more */ }
  }
}

const { charWidth } = ansi;

function textWidth(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch.codePointAt(0));
  return w;
}

// Truncates or pads plain text to exactly `width` columns, counting wide
// characters (emoji icons, CJK) as two.
function fit(text, width) {
  if (width <= 0) return '';
  const chars = [...String(text)];
  if (textWidth(text) <= width) return chars.join('') + ' '.repeat(width - textWidth(text));
  let out = '';
  let w = 0;
  for (const ch of chars) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…${' '.repeat(Math.max(0, width - w - 1))}`;
}

// A full-width title or status bar in the theme's bar colours.
function bar(text, cols) {
  if (!ansi.isEnabled()) return fit(text, cols);
  const { ui } = require('./theme').current();
  return `${ansi.sgr(`48;5;${ui.bar.bg}`)}${ansi.fg(ui.bar.fg)}${fit(text, cols)}${ansi.reset()}`;
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
  const { ui } = require('./theme').current();
  const color = ansi.fg(f > 0.85 ? ui.err : f > 0.6 ? ui.warn : ui.ok);
  return `[${color}${'|'.repeat(filled)}${ansi.reset()}${' '.repeat(inner - filled)}]`;
}

module.exports = { MOUSE_ON, MOUSE_OFF, requireTty, fullscreen, fit, bar, humanBytes, meter, charWidth, textWidth };
