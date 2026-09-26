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
// signature two-line prompt.
function usesDefaultPrompt(shell) {
  return !shell.getVar('PROMPT') && !shell.getVar('PS1');
}

// The two-line prompt: a framed information line (folder, git, and the right
// prompt pushed to the far edge), then a short input line whose ❯ turns red
// when the last command failed.
//
//   ╭─ ~/maxshell · main !?                              node v25 · 12:04
//   ╰─❯
function promptParts(shell, cols = 80) {
  const p = theme.current().prompt;
  const R = ansi.reset();
  const frame = ansi.fg(p.frame);
  const home = shell.getVar('HOME') || os.homedir();
  const where = shortCwd(shell.cwd, home);

  let left = `${frame}╭─${R} ${ansi.bold()}${ansi.fg(p.path)}${where}${R}`;
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

  const rightTemplate = shell.getVar('RPROMPT') ?? shell.getVar('RPS1') ?? '%V · %T';
  const rightText = rightTemplate ? expandPrompt(rightTemplate, shell) : '';
  const right = rightText ? `${ansi.fg(p.right)}${ansi.strip(rightText)}${R}` : '';

  // Leave the last column free so the line never wraps.
  const room = cols - 1;
  const lw = textWidth(ansi.strip(left));
  const rw = textWidth(ansi.strip(right));
  let header = left;
  if (right && lw + rw + 2 <= room) header += ' '.repeat(room - lw - rw) + right;
  else if (lw > room) header = ansi.strip(left).slice(0, room);

  const failed = shell.status !== 0 && shell.status !== 130;
  const input = `${frame}╰─${R}${ansi.fg(failed ? p.charErr : p.char)}❯${R} `;
  return { header, input };
}

// What a finished prompt collapses to, so scrollback shows one tidy line per
// command: the folder in muted text, then ❯ and the command as typed.
function compactPrompt(shell, line, paint = (x) => x) {
  const p = theme.current().prompt;
  const R = ansi.reset();
  const home = shell.getVar('HOME') || os.homedir();
  return `${ansi.fg(p.right)}${shortCwd(shell.cwd, home)}${R} ${ansi.fg(p.char)}❯${R} ${paint(line)}`;
}

module.exports = {
  expandPrompt, leftPrompt, rightPrompt, gitSegment, shortCwd, DEFAULT_PROMPT, DEFAULT_RPROMPT,
  usesDefaultPrompt, promptParts, compactPrompt,
};
