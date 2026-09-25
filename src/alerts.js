'use strict';

const { spawnSync, spawn } = require('child_process');

// After-command feedback: how long it took, whether it failed, and a
// desktop notification when something slow finishes while you're elsewhere.

function formatDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// The line printed after a command, or null when there is nothing worth
// saying (quick and successful). 127 is left to the did-you-mean message.
function statusLine(status, ms, { minMs = 1000 } = {}) {
  if (status === 127) return null;
  if (status === 130) return { ok: false, text: '✗ interrupted' };
  if (status !== 0) return { ok: false, text: `✗ exit ${status}${ms >= minMs ? ` · ${formatDuration(ms)}` : ''}` };
  if (ms >= minMs) return { ok: true, text: `✓ ${formatDuration(ms)}` };
  return null;
}

const TERMINAL_APPS = [
  'Terminal', 'iTerm2', 'iTerm', 'Warp', 'Ghostty', 'Alacritty', 'kitty', 'WezTerm',
  'Hyper', 'Tabby', 'Code', 'Visual Studio Code', 'Cursor', 'Zed',
];

// Name of the app in front on macOS, or null if it can't be told.
function frontApp() {
  if (process.platform !== 'darwin') return null;
  try {
    const asn = spawnSync('lsappinfo', ['front'], { encoding: 'utf8', timeout: 800 }).stdout.trim();
    if (!asn) return null;
    const info = spawnSync('lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8', timeout: 800 }).stdout;
    const m = /"LSDisplayName"="([^"]*)"/.exec(info || '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Notify only if you are looking at some other app.
function shouldNotify(ms, thresholdMs, front) {
  if (ms < thresholdMs) return false;
  if (!front) return true;
  return !TERMINAL_APPS.some((t) => front.toLowerCase() === t.toLowerCase());
}

function notify(title, body) {
  try {
    if (process.platform === 'darwin') {
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`],
        { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('notify-send', [title, body], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { formatDuration, statusLine, frontApp, shouldNotify, notify, TERMINAL_APPS };
