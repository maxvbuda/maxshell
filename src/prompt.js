'use strict';

const os = require('os');
const path = require('path');

const ansi = require('./ansi');
const { gitInfo } = require('./gitprompt');

const DEFAULT_PROMPT = '%F{cyan}%~%f%g %# ';
const DEFAULT_RPROMPT = '%F{244}%V · %T%f';

// " on main ↑2 !1", coloured, or "" outside a repo.
function gitSegment(cwd) {
  const info = gitInfo(cwd);
  if (!info) return '';

  const R = ansi.reset();
  let out = `${ansi.fg('gray')} on ${R}${ansi.fg('magenta')}${info.branch}${R}`;

  let marks = '';
  if (info.ahead) marks += `↑${info.ahead}`;
  if (info.behind) marks += `↓${info.behind}`;
  if (info.staged) marks += '+';
  if (info.dirty) marks += '!';
  if (info.untracked) marks += '?';
  if (marks) out += ` ${ansi.fg('yellow')}${marks}${R}`;

  return out;
}

function shortCwd(cwd, home) {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function expandPrompt(template, shell) {
  const home = shell.getVar('HOME') || os.homedir();

  return String(template).replace(/%F\{([^}]*)\}|%(.)/g, (match, colorName, code) => {
    if (colorName !== undefined) return ansi.fg(/^\d+$/.test(colorName) ? Number(colorName) : colorName);
    switch (code) {
      case 'f': return ansi.reset();
      case 'B': return ansi.bold();
      case 'b': return ansi.noBold();
      case 'U': return ansi.underline();
      case 'u': return ansi.noUnderline();
      case '~': return shortCwd(shell.cwd, home);
      case 'd': case '/': return shell.cwd;
      case 'c': case 'C': return path.basename(shell.cwd);
      case 'n': return os.userInfo().username;
      case 'm': return os.hostname().split('.')[0];
      case 'M': return os.hostname();
      case 'g': return gitSegment(shell.cwd);
      case 'V': return `node ${process.version}`;
      case 'T': return new Date().toTimeString().slice(0, 5);
      case 't': return new Date().toTimeString().slice(0, 8);
      case '?': return String(shell.status);
      case '#': return process.getuid && process.getuid() === 0 ? '#' : '%';
      case '%': return '%';
      default: return match;
    }
  });
}

function leftPrompt(shell) {
  return expandPrompt(shell.getVar('PROMPT') || shell.getVar('PS1') || DEFAULT_PROMPT, shell);
}

function rightPrompt(shell) {
  const template = shell.getVar('RPROMPT') ?? shell.getVar('RPS1') ?? DEFAULT_RPROMPT;
  return template ? expandPrompt(template, shell) : '';
}

module.exports = { expandPrompt, leftPrompt, rightPrompt, gitSegment, shortCwd, DEFAULT_PROMPT, DEFAULT_RPROMPT };
