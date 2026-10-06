'use strict';

const ansi = require('./ansi');
const theme = require('./theme');
const { textWidth } = require('./tui');

// The wordmark, in a two-row block font.
const LOGO = [
  '█▀▄▀█ ▄▀█ ▀▄▀ █▀ █ █ █▀▀ █   █  ',
  '█ ▀ █ █▀█ █ █ ▄█ █▀█ ██▄ █▄▄ █▄▄',
];

const TIPS = [
  'Ctrl-R fuzzy-searches every command you have ever run',
  'j cook jumps to the folder you use most that matches “cook”',
  'files opens a Finder-style browser — double-click works',
  'theme lists eight colour schemes; theme nord switches to one',
  'edit app.py — nano-style, and ^T runs your code',
  'mistype a command? press Enter to run the suggested fix',
  'back and forward walk your folder history, like a browser',
  'cmd | view pages output with highlighting and search',
  'top is a live process monitor; gitui stages and commits',
  'a ✓ or ✗ after slow commands says how long they took',
  'sage — an AI that lives on your Mac: private and offline',
  'sage code builds and fixes your project — you OK every change',
];

// The logo painted across the theme gradient by column, so both rows line up.
function logoLines(colors = theme.current().gradient) {
  const width = LOGO[0].length;
  return LOGO.map((row) => {
    if (!ansi.isEnabled()) return row;
    let out = '';
    let last = null;
    [...row].forEach((ch, i) => {
      const c = colors[Math.min(colors.length - 1, Math.floor((i / width) * colors.length))];
      if (ch !== ' ' && c !== last) { out += ansi.fg(c); last = c; }
      out += ch;
    });
    return out + ansi.reset();
  });
}

function banner({ version, cols = 80, tip = TIPS[Math.floor(Math.random() * TIPS.length)] } = {}) {
  const { ui } = theme.current();
  const R = ansi.reset();
  const logo = logoLines();
  const line1 = `${ansi.bold()}maxshell ${version}${R}${ansi.fg(ui.muted)} · theme ${theme.currentThemeName()}${R}`;
  const line2 = `${ansi.fg(ui.muted)}tip: ${R}${tip}`;
  const logoW = LOGO[0].length + 2;
  // Side by side when there is room, stacked otherwise.
  const infoW = Math.max(textWidth(ansi.strip(line1)), textWidth(ansi.strip(line2)));
  if (cols >= logoW + 4 + infoW) {
    return `\n  ${logo[0]}    ${line1}\n  ${logo[1]}    ${line2}\n\n`;
  }
  return `\n  ${logo[0]}\n  ${logo[1]}\n  ${line1}\n  ${line2}\n\n`;
}

module.exports = { LOGO, TIPS, logoLines, banner };
