'use strict';

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

let enabled = true;

function setEnabled(value) { enabled = !!value; }
function isEnabled() { return enabled; }

const NAMED = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  gray: 8, grey: 8, brightred: 9, brightgreen: 10, brightyellow: 11,
  brightblue: 12, brightmagenta: 13, brightcyan: 14, brightwhite: 15,
};

function sgr(code) { return enabled ? `\x1b[${code}m` : ''; }

function fg(color) {
  if (!enabled) return '';
  const n = typeof color === 'number' ? color : NAMED[String(color).toLowerCase()];
  if (n === undefined || Number.isNaN(Number(n))) return '';
  return `\x1b[38;5;${Number(n)}m`;
}

const reset = () => sgr(0);
const bold = () => sgr(1);
const dim = () => sgr(2);
const underline = () => sgr(4);
const noBold = () => sgr(22);
const noUnderline = () => sgr(24);
const reverse = () => sgr(7);
const noReverse = () => sgr(27);

function strip(s) { return String(s).replace(ANSI_RE, ''); }

// Terminal columns a code point occupies: 0 for combining marks and joiners,
// 2 for emoji and East Asian wide characters, otherwise 1.
function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if ((cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x1f000 && cp <= 0x1f2ff)
    || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

// Printable width in terminal columns, ignoring escape sequences.
function width(s) {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

module.exports = {
  setEnabled, isEnabled, fg, sgr, reset, bold, dim, underline, noBold, noUnderline,
  reverse, noReverse, strip, width, charWidth, NAMED,
};
