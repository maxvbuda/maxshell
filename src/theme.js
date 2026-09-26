'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ansi = require('./ansi');

// Every colour maxshell draws comes from the current theme. Colours are
// xterm-256 numbers; a style may also be { c, bold, underline }.
//
//   gradient  the logo, left to right
//   ui        accents, bars, selection, meters and the files folder icon
//   prompt    the two-line default prompt
//   shell     the live command-line highlighter
//   syntax    code in edit / view / files previews

const B = (c) => ({ c, bold: true });
const U = (c) => ({ c, underline: true });

const THEMES = {
  maxshell: {
    description: 'electric cyan to magenta — the house style',
    gradient: [51, 45, 39, 33, 63, 99, 135, 171, 207],
    ui: {
      accent: 45, accent2: 207, muted: 244, ok: 78, err: 203, warn: 214,
      bar: { fg: 255, bg: 24 }, select: { fg: 255, bg: 25 }, selectDim: 238, marked: 24,
      folder: { t: 68, h: 153, f: 117, b: 75, s: 68 }, dir: 75,
    },
    prompt: { path: 45, branch: 207, marks: 214, char: 45, charErr: 203, right: 244, frame: 240 },
    shell: {
      reserved: B(4), builtin: 2, command: 2, alias: 6, unknown: 1, string: 3,
      variable: 6, operator: 5, comment: 8, assign: 6,
    },
    syntax: {
      kw: B(5), const: 213, builtin: 6, str: 3, num: 2, comment: 8, decorator: 214, defname: B(4),
      op: 252, key: 75, var: 81, heading: B(75), emph: B(223), code: 180, link: U(111), quote: 245, bullet: 214,
    },
  },

  dracula: {
    description: 'purple, pink and neon green on dark',
    gradient: [212, 213, 177, 141, 105, 117],
    ui: {
      accent: 141, accent2: 212, muted: 61, ok: 84, err: 203, warn: 228,
      bar: { fg: 231, bg: 60 }, select: { fg: 231, bg: 61 }, selectDim: 237, marked: 60,
      folder: { t: 98, h: 183, f: 141, b: 105, s: 98 }, dir: 141,
    },
    prompt: { path: 141, branch: 212, marks: 228, char: 212, charErr: 203, right: 61, frame: 60 },
    shell: {
      reserved: B(212), builtin: 117, command: 84, alias: 117, unknown: 203, string: 228,
      variable: 141, operator: 212, comment: 61, assign: 141,
    },
    syntax: {
      kw: B(212), const: 141, builtin: 117, str: 228, num: 141, comment: 61, decorator: 84, defname: B(84),
      op: 212, key: 117, var: 141, heading: B(141), emph: B(215), code: 228, link: U(117), quote: 61, bullet: 212,
    },
  },

  nord: {
    description: 'cool arctic blues and frost',
    gradient: [110, 109, 67, 68, 73, 110],
    ui: {
      accent: 110, accent2: 139, muted: 60, ok: 108, err: 167, warn: 222,
      bar: { fg: 255, bg: 60 }, select: { fg: 255, bg: 67 }, selectDim: 237, marked: 60,
      folder: { t: 67, h: 152, f: 110, b: 68, s: 60 }, dir: 110,
    },
    prompt: { path: 110, branch: 139, marks: 222, char: 110, charErr: 167, right: 60, frame: 59 },
    shell: {
      reserved: B(109), builtin: 110, command: 108, alias: 110, unknown: 167, string: 108,
      variable: 139, operator: 109, comment: 60, assign: 139,
    },
    syntax: {
      kw: B(109), const: 139, builtin: 110, str: 108, num: 139, comment: 60, decorator: 222, defname: B(110),
      op: 109, key: 110, var: 139, heading: B(110), emph: B(222), code: 108, link: U(110), quote: 60, bullet: 222,
    },
  },

  gruvbox: {
    description: 'warm retro yellows, oranges and olive',
    gradient: [214, 208, 167, 175, 108, 142],
    ui: {
      accent: 214, accent2: 108, muted: 245, ok: 142, err: 167, warn: 214,
      bar: { fg: 223, bg: 237 }, select: { fg: 223, bg: 66 }, selectDim: 237, marked: 239,
      folder: { t: 172, h: 223, f: 214, b: 208, s: 172 }, dir: 214,
    },
    prompt: { path: 214, branch: 108, marks: 208, char: 142, charErr: 167, right: 245, frame: 239 },
    shell: {
      reserved: B(167), builtin: 108, command: 142, alias: 108, unknown: 167, string: 142,
      variable: 109, operator: 208, comment: 245, assign: 109,
    },
    syntax: {
      kw: B(167), const: 175, builtin: 108, str: 142, num: 175, comment: 245, decorator: 208, defname: B(214),
      op: 208, key: 109, var: 109, heading: B(214), emph: B(208), code: 142, link: U(109), quote: 245, bullet: 208,
    },
  },

  solarized: {
    description: 'the precise, balanced classic',
    gradient: [33, 37, 64, 136, 166, 125],
    ui: {
      accent: 33, accent2: 37, muted: 245, ok: 64, err: 160, warn: 136,
      bar: { fg: 230, bg: 24 }, select: { fg: 230, bg: 33 }, selectDim: 236, marked: 24,
      folder: { t: 25, h: 117, f: 74, b: 32, s: 24 }, dir: 33,
    },
    prompt: { path: 33, branch: 37, marks: 136, char: 37, charErr: 160, right: 245, frame: 240 },
    shell: {
      reserved: B(64), builtin: 37, command: 64, alias: 37, unknown: 160, string: 37,
      variable: 33, operator: 136, comment: 245, assign: 33,
    },
    syntax: {
      kw: B(64), const: 166, builtin: 37, str: 37, num: 125, comment: 245, decorator: 136, defname: B(33),
      op: 136, key: 33, var: 33, heading: B(166), emph: B(136), code: 37, link: U(33), quote: 245, bullet: 136,
    },
  },

  'tokyo-night': {
    description: 'city-light blues and violets',
    gradient: [117, 111, 147, 141, 176, 211],
    ui: {
      accent: 111, accent2: 141, muted: 60, ok: 149, err: 203, warn: 215,
      bar: { fg: 189, bg: 237 }, select: { fg: 231, bg: 61 }, selectDim: 236, marked: 238,
      folder: { t: 62, h: 153, f: 111, b: 69, s: 61 }, dir: 111,
    },
    prompt: { path: 111, branch: 141, marks: 215, char: 141, charErr: 203, right: 60, frame: 238 },
    shell: {
      reserved: B(141), builtin: 117, command: 149, alias: 117, unknown: 203, string: 149,
      variable: 215, operator: 117, comment: 60, assign: 215,
    },
    syntax: {
      kw: B(141), const: 215, builtin: 117, str: 149, num: 215, comment: 60, decorator: 215, defname: B(111),
      op: 117, key: 111, var: 215, heading: B(111), emph: B(215), code: 149, link: U(117), quote: 60, bullet: 141,
    },
  },

  sunset: {
    description: 'golden hour: amber, coral and rose',
    gradient: [226, 220, 214, 208, 202, 197, 161],
    ui: {
      accent: 209, accent2: 205, muted: 138, ok: 150, err: 197, warn: 221,
      bar: { fg: 230, bg: 95 }, select: { fg: 230, bg: 131 }, selectDim: 237, marked: 95,
      folder: { t: 166, h: 223, f: 216, b: 209, s: 166 }, dir: 216,
    },
    prompt: { path: 209, branch: 205, marks: 221, char: 205, charErr: 197, right: 138, frame: 95 },
    shell: {
      reserved: B(205), builtin: 216, command: 150, alias: 216, unknown: 197, string: 221,
      variable: 209, operator: 205, comment: 138, assign: 209,
    },
    syntax: {
      kw: B(205), const: 209, builtin: 216, str: 221, num: 209, comment: 138, decorator: 221, defname: B(216),
      op: 205, key: 216, var: 209, heading: B(209), emph: B(221), code: 223, link: U(216), quote: 138, bullet: 205,
    },
  },

  mono: {
    description: 'no colour, just weight and shade',
    gradient: [255, 252, 249, 246, 243, 240],
    ui: {
      accent: 255, accent2: 250, muted: 242, ok: 250, err: 255, warn: 250,
      bar: { fg: 232, bg: 250 }, select: { fg: 232, bg: 250 }, selectDim: 238, marked: 240,
      folder: { t: 244, h: 253, f: 250, b: 246, s: 242 }, dir: 255,
    },
    prompt: { path: 255, branch: 250, marks: 245, char: 255, charErr: 244, right: 242, frame: 238 },
    shell: {
      reserved: B(255), builtin: 252, command: 255, alias: 252, unknown: U(245), string: 250,
      variable: 252, operator: 245, comment: 240, assign: 252,
    },
    syntax: {
      kw: B(255), const: 250, builtin: 252, str: 250, num: 250, comment: 240, decorator: 248, defname: B(255),
      op: 245, key: 252, var: 252, heading: B(255), emph: B(255), code: 248, link: U(252), quote: 242, bullet: 248,
    },
  },
};

const DEFAULT = 'maxshell';
let currentName = DEFAULT;

function names() { return Object.keys(THEMES); }

function current() { return THEMES[currentName]; }

function currentThemeName() { return currentName; }

function setTheme(name) {
  if (!THEMES[name]) return false;
  currentName = name;
  return true;
}

// Runs `fn` with another theme in effect, e.g. to draw a preview swatch.
function withTheme(name, fn) {
  const saved = currentName;
  if (THEMES[name]) currentName = name;
  try { return fn(); } finally { currentName = saved; }
}

// The escape sequence for a style (number or { c, bold, underline }).
function style(s) {
  if (s === undefined || s === null || s === '') return '';
  if (typeof s === 'number') return ansi.fg(s);
  return (s.bold ? ansi.bold() : '') + (s.underline ? ansi.underline() : '') + ansi.fg(s.c);
}

// Shorthands for UI colours by role.
function fg(role) { return style(current().ui[role]); }
function bg(n) { return ansi.sgr(`48;5;${n}`); }

// Paints `text` across the theme's gradient, one colour band per chunk of
// columns.
function gradientText(text, colors = current().gradient) {
  if (!ansi.isEnabled()) return text;
  const chars = [...text];
  const visible = chars.filter((c) => c !== ' ').length || 1;
  let seen = 0;
  let out = '';
  for (const ch of chars) {
    if (ch === ' ') { out += ch; continue; }
    const idx = Math.min(colors.length - 1, Math.floor((seen / visible) * colors.length));
    out += ansi.fg(colors[idx]) + ch;
    seen++;
  }
  return out + ansi.reset();
}

function themeFile() {
  return process.env.MAXSHELL_THEME_FILE || path.join(os.homedir(), '.maxshell_theme');
}

// Loads the saved theme; MAXSHELL_THEME overrides it for one session.
function loadSavedTheme() {
  const forced = process.env.MAXSHELL_THEME;
  if (forced && setTheme(forced)) return currentName;
  try {
    const saved = fs.readFileSync(themeFile(), 'utf8').trim();
    if (saved) setTheme(saved);
  } catch { /* none saved */ }
  return currentName;
}

function saveTheme(name) {
  fs.writeFileSync(themeFile(), `${name}\n`);
}

module.exports = {
  THEMES, DEFAULT, names, current, currentThemeName, setTheme, withTheme,
  style, fg, bg, gradientText, themeFile, loadSavedTheme, saveTheme,
};
