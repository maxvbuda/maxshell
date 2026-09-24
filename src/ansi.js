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

// Printable width, ignoring escape sequences.
function width(s) { return [...strip(s)].length; }

module.exports = {
  setEnabled, isEnabled, fg, sgr, reset, bold, dim, underline, noBold, noUnderline,
  reverse, noReverse, strip, width, NAMED,
};
