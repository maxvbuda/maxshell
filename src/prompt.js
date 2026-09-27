'use strict';

const os = require('os');
const path = require('path');

const ansi = require('./ansi');
const { gitInfo } = require('./gitprompt');
const theme = require('./theme');
const { textWidth } = require('./tui');

const DEFAULT_PROMPT = '%F{cyan}%~%f%g %# ';
const DEFAULT_RPROMPT = '%F{244}%V · %T%f';

// " on main ↑2 !1", coloured, or "" outside a repo.
function gitSegment(cwd) {
  const info = gitInfo(cwd);
  if (!info) return '';

  const p = theme.current().prompt;
  const R = ansi.reset();
  let out = `${ansi.fg(p.frame)} on ${R}${ansi.fg(p.branch)}${info.branch}${R}`;

  let marks = '';
  if (info.ahead) marks += `↑${info.ahead}`;
  if (info.behind) marks += `↓${info.behind}`;
  if (info.staged) marks += '+';
  if (info.dirty) marks += '!';
  if (info.untracked) marks += '?';
  if (marks) out += ` ${ansi.fg(p.marks)}${marks}${R}`;

  return out;
}

function shortCwd(cwd, home) {
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function expandPrompt(template, shell) {
  const home = shell.getVar('HOME') || os.homedir();

  return String(template).replace(/%F\{([^}]*)\}|%(.)/g, (match, colorName, code) => {
    if (colorName !== undefined) {
      if (/^\d+$/.test(colorName)) return ansi.fg(Number(colorName));
      const role = theme.current().ui[colorName];
      return typeof role === 'number' ? ansi.fg(role) : ansi.fg(colorName);
    }
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

// Whether the user has chosen their own prompt; if not, maxshell draws its
// signature prompt.
function usesDefaultPrompt(shell) {
  return !shell.getVar('PROMPT') && !shell.getVar('PS1');
}

// The signature prompt, on one line: the folder and git state on the left,
// then ❯ (the error colour after a failed command); on the right, the tools
// this project uses, how long a slow command took, and the time.
//
//   ~/maxshell · main !? ❯                          📦 v0.12.0 · ⬢ 25.1.0 · 12:04
function promptParts(shell, cols = 80) {
  const p = theme.current().prompt;
  const R = ansi.reset();
  const frame = ansi.fg(p.frame);
  const home = shell.getVar('HOME') || os.homedir();
  const full = shortCwd(shell.cwd, home);
  // Long paths shorten fish-style so there's room to type:
  // ~/projects/website/src → ~/p/w/src
  const where = shortenPath(full, Math.max(12, Math.floor((cols - 1) * 0.4)));

  let left = `${ansi.bold()}${ansi.fg(p.path)}${where}${R}`;
  const info = gitInfo(shell.cwd);
  if (info) {
    left += `${frame} · ${R}${ansi.fg(p.branch)}${info.branch}${R}`;
    let marks = '';
    if (info.ahead) marks += `↑${info.ahead}`;
    if (info.behind) marks += `↓${info.behind}`;
    if (info.staged) marks += '+';
    if (info.dirty) marks += '!';
    if (info.untracked) marks += '?';
    if (marks) left += ` ${ansi.fg(p.marks)}${marks}${R}`;
  }
  const failed = shell.status !== 0 && shell.status !== 130;
  const input = `${left} ${ansi.fg(failed ? p.charErr : p.char)}❯${R} `;

  // The right side: RPROMPT if you set one; otherwise the tools this project
  // uses, how long the last command took (if it was slow), and the time.
  const custom = shell.getVar('RPROMPT') ?? shell.getVar('RPS1');
  let parts;
  if (custom !== undefined) {
    parts = custom ? [`${ansi.fg(p.right)}${ansi.strip(expandPrompt(custom, shell))}${R}`] : [];
  } else {
    const { promptModules } = require('./context');
    parts = promptModules(shell).map((m) => `${ansi.fg(p.right)}${m.text}${R}`);
    if (shell.lastDuration >= 2000) {
      const { formatDuration } = require('./alerts');
      parts.push(`${ansi.fg(theme.current().ui.warn)}took ${formatDuration(shell.lastDuration)}${R}`);
    }
    parts.push(`${ansi.fg(p.right)}${new Date().toTimeString().slice(0, 5)}${R}`);
  }

  // Keep the right side to about half the line, leaving room to type; if
  // everything won't fit, drop modules from the front, keeping the time.
  const sep = `${ansi.fg(p.frame)} · ${R}`;
  const widthOf = (list) => textWidth(ansi.strip(list.join(sep)));
  const room = Math.max(0, cols - 1 - textWidth(ansi.strip(input)) - 10);
  while (parts.length && widthOf(parts) > room) parts.shift();
  const right = parts.join(sep);
  return { input, right };
}

// Abbreviates every folder but the last to its first letter (keeping a
// leading dot), then, if still too long, keeps only the tail.
function shortenPath(p, maxW) {
  if (textWidth(p) <= maxW) return p;
  const parts = p.split('/');
  const abbreviated = parts.map((seg, i) => {
    if (i === parts.length - 1 || seg === '' || seg === '~') return seg;
    return seg.startsWith('.') ? seg.slice(0, 2) : seg.slice(0, 1);
  }).join('/');
  if (textWidth(abbreviated) <= maxW) return abbreviated;
  const last = parts[parts.length - 1];
  return `…/${last}`.length <= maxW ? `…/${last}` : `…${last.slice(-(maxW - 1))}`;
}

// What a finished prompt collapses to, so scrollback shows one tidy line per
// command: the folder in muted text, then ❯ and the command as typed.
function compactPrompt(shell, line, paint = (x) => x) {
  const p = theme.current().prompt;
  const R = ansi.reset();
  const home = shell.getVar('HOME') || os.homedir();
  const where = shortenPath(shortCwd(shell.cwd, home), 40);
  return `${ansi.fg(p.right)}${where}${R} ${ansi.fg(p.char)}❯${R} ${paint(line)}`;
}

// Tells the terminal where we are: OSC 7 (so a new tab or window opens in
// the same folder, as with zsh on macOS) and the window title.
function terminalTitle(shell) {
  const home = shell.getVar('HOME') || os.homedir();
  const host = os.hostname();
  const url = `file://${host}${encodeURI(shell.cwd).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  const title = shortCwd(shell.cwd, home).replace(/[\x00-\x1f\x7f]/g, '');
  return `\x1b]7;${url}\x07\x1b]0;${title}\x07`;
}

module.exports = {
  expandPrompt, leftPrompt, rightPrompt, gitSegment, shortCwd, DEFAULT_PROMPT, DEFAULT_RPROMPT,
  usesDefaultPrompt, promptParts, compactPrompt, shortenPath, terminalTitle,
};
