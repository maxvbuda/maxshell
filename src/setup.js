'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Making maxshell your login shell. A Node script can't be a login shell
// directly: Terminal starts it with a bare PATH, where `env node` may not
// find Node. So a small wrapper runs Node by its full path — and falls back
// to zsh if Node or maxshell has gone missing, so you're never locked out of
// your terminal. It goes into /etc/shells (which needs your password) and
// then chsh makes it yours.

const ROOT = path.resolve(__dirname, '..');

function home() { return process.env.HOME || os.homedir(); }

function stateFile() {
  return process.env.MAXSHELL_STATE_FILE || path.join(home(), '.maxshell_state');
}

function profileFile() {
  return path.join(home(), '.maxshell_profile');
}

// The login wrapper's location: a stable path, even if the repo moves
// (setup rewrites the wrapper then).
function wrapperPath() {
  return process.env.MAXSHELL_WRAPPER || path.join(home(), '.maxshell', 'bin', 'maxshell');
}

// Your current login shell, as the system has it.
function loginShell() {
  if (process.platform === 'darwin') {
    const r = spawnSync('dscl', ['.', '-read', home(), 'UserShell'], { encoding: 'utf8', timeout: 3000 });
    const m = /UserShell:\s*(\S+)/.exec(r.stdout || '');
    if (m) return m[1];
  }
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${os.userInfo().username}:`));
    if (line) return line.split(':').pop();
  } catch { /* no passwd file */ }
  return process.env.SHELL || '';
}

function isDefault() {
  const shell = loginShell();
  return shell === wrapperPath() || /maxshell/.test(path.basename(shell));
}

// Node's path as found on PATH (/opt/homebrew/bin/node), not the versioned
// Cellar path it resolves to, so a Node upgrade doesn't break the wrapper.
function nodePath() {
  for (const dir of (process.env.PATH || '').split(':').filter(Boolean)) {
    const p = path.join(dir, 'node');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return process.execPath;
}

function wrapperScript(node = nodePath(), js = path.join(ROOT, 'bin', 'maxshell.js')) {
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh
# maxshell's login wrapper (written by maxshell --make-default).
# Runs maxshell with a known Node; if either has gone missing, falls back to
# zsh so the terminal still opens. To switch back: chsh -s /bin/zsh
NODE=${q(node)}
MAXSHELL=${q(js)}
if [ -x "$NODE" ] && [ -f "$MAXSHELL" ]; then
  exec "$NODE" "$MAXSHELL" "$@"
fi
echo "maxshell: can't find $NODE or $MAXSHELL — starting zsh instead" >&2
exec /bin/zsh "$@"
`;
}

function writeWrapper() {
  const file = wrapperPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wrapperScript(), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

// Saves the PATH you have now (Homebrew and all), for login shells.
// maxshell doesn't read ~/.zprofile, so this keeps your tools reachable.
function writeProfile(currentPath = process.env.PATH || '') {
  const file = profileFile();
  const line = `export PATH='${currentPath.replace(/'/g, "'\\''")}'`;
  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (/^export PATH=/m.test(body)) body = body.replace(/^export PATH=.*$/m, line);
  else body = `# Loaded by maxshell when it starts as a login shell.\n${line}\n${body}`;
  fs.writeFileSync(file, body);
  return file;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function writeState(patch) {
  const state = { ...readState(), ...patch };
  try { fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`); } catch { /* best effort */ }
}

// Does the whole thing, talking as it goes. Returns true on success.
function makeDefault(say = (t) => process.stdout.write(t)) {
  const wrapper = writeWrapper();
  const profile = writeProfile();
  say(`  ✓ login wrapper  ${wrapper}\n  ✓ your PATH saved in ${profile}\n`);

  let shells = '';
  try { shells = fs.readFileSync('/etc/shells', 'utf8'); } catch { /* none */ }
  if (!shells.split('\n').includes(wrapper)) {
    say('  adding it to /etc/shells (your Mac password, for sudo):\n');
    const r = spawnSync('sudo', ['sh', '-c', `echo '${wrapper}' >> /etc/shells`], { stdio: 'inherit' });
    if (r.status !== 0) { say('  ✗ couldn’t update /etc/shells — nothing was changed\n'); return false; }
    say('  ✓ added to /etc/shells\n');
  }
  say('  switching your login shell (your password again, for chsh):\n');
  const r = spawnSync('chsh', ['-s', wrapper], { stdio: 'inherit' });
  if (r.status !== 0) { say('  ✗ chsh didn’t change it\n'); return false; }
  writeState({ default: true, askedDefault: true });
  say('  ✓ maxshell is your default shell. New terminal windows open in it.\n'
    + '    (to go back: chsh -s /bin/zsh)\n');
  return true;
}

// On the first interactive start, offers once to become the default shell.
// Returns a promise; `ask` reads a line.
async function offerDefault(ask, say) {
  if (process.env.MAXSHELL_SETUP === '0') return;
  const state = readState();
  if (state.askedDefault) return;
  if (isDefault()) { writeState({ askedDefault: true }); return; }
  writeState({ askedDefault: true });
  say('\n  Make maxshell your default shell, so every new terminal opens in it? [y/N] ');
  const answer = (await ask()) || '';
  if (/^y(es)?$/i.test(answer.trim())) {
    say('\n');
    makeDefault(say);
  } else {
    say('  Okay. Run maxshell --make-default whenever you like.\n');
  }
  say('\n');
}

module.exports = {
  wrapperPath, wrapperScript, writeWrapper, writeProfile, profileFile, loginShell, isDefault, makeDefault,
  offerDefault, readState, writeState, stateFile, nodePath,
};
