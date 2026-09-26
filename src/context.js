'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Starship-style prompt modules: show a tool's version only inside projects
// that use it. Versions are looked up once per session; the project scan is
// cached per folder for a moment so redrawing stays cheap.

const versionCache = new Map();

function toolVersion(cmd, args, pattern, env) {
  const key = `${cmd} ${args.join(' ')}`;
  if (versionCache.has(key)) return versionCache.get(key);
  let v = null;
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1500, env });
    const m = pattern.exec(`${res.stdout || ''}${res.stderr || ''}`);
    if (m) v = m[1];
  } catch { /* not installed */ }
  versionCache.set(key, v);
  return v;
}

const MODULES = [
  {
    id: 'node', icon: '⬢',
    markers: ['package.json', '.nvmrc', '.node-version'],
    version: (env) => toolVersion('node', ['--version'], /v?(\d+\.\d+\.\d+)/, env),
  },
  {
    id: 'python', icon: '🐍',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', '.python-version', 'poetry.lock'],
    extensions: ['.py'],
    version: (env) => toolVersion('python3', ['--version'], /Python (\d+\.\d+\.\d+)/, env),
  },
  {
    id: 'rust', icon: '🦀',
    markers: ['Cargo.toml'],
    version: (env) => toolVersion('rustc', ['--version'], /rustc (\d+\.\d+\.\d+)/, env),
  },
  {
    id: 'go', icon: '🐹',
    markers: ['go.mod'],
    version: (env) => toolVersion('go', ['version'], /go(\d+\.\d+(?:\.\d+)?)/, env),
  },
  {
    id: 'ruby', icon: '💎',
    markers: ['Gemfile', '.ruby-version'],
    version: (env) => toolVersion('ruby', ['--version'], /ruby (\d+\.\d+\.\d+)/, env),
  },
  { id: 'docker', icon: '🐳', markers: ['Dockerfile', 'compose.yaml', 'docker-compose.yml'], version: null },
];

const scanCache = new Map();
const SCAN_TTL_MS = 2000;

// Walks up from `cwd` to the nearest folder that looks like a project (or
// the home folder), and reports which modules apply there.
function detect(cwd, home) {
  const hit = scanCache.get(cwd);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.found;

  const found = { modules: [], root: null, pkg: null };
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* unreadable */ }
    const set = new Set(names);
    for (const mod of MODULES) {
      if (found.modules.includes(mod)) continue;
      const byMarker = mod.markers.some((m) => set.has(m));
      const byExt = dir === cwd && mod.extensions && names.some((n) => mod.extensions.includes(path.extname(n)));
      if (byMarker || byExt) found.modules.push(mod);
    }
    if (!found.pkg && set.has('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.version) found.pkg = { name: pkg.name, version: pkg.version };
      } catch { /* malformed */ }
    }
    if (found.modules.length && !found.root) found.root = dir;
    // Stop at a project root, the home folder, or the top of the disk.
    if (set.has('.git') || dir === home || path.dirname(dir) === dir) break;
  }

  scanCache.set(cwd, { at: Date.now(), found });
  return found;
}

// Short labels for the prompt, e.g. ["📦 v0.9.0", "⬢ 25.1.0", "🐍 3.12.1 (venv)"].
function promptModules(shell) {
  const home = shell.getVar('HOME') || require('os').homedir();
  const { modules, pkg } = detect(shell.cwd, home);
  const out = [];
  if (pkg) out.push({ id: 'package', text: `📦 v${pkg.version}` });
  for (const mod of modules) {
    const v = mod.version ? mod.version(shell.env) : null;
    let text = v ? `${mod.icon} ${v}` : mod.icon;
    if (mod.id === 'python') {
      const venv = shell.getVar('VIRTUAL_ENV') || shell.env.VIRTUAL_ENV;
      if (venv) text += ` (${path.basename(venv)})`;
    }
    out.push({ id: mod.id, text });
  }
  return out;
}

function clearCaches() {
  scanCache.clear();
  versionCache.clear();
}

module.exports = { detect, promptModules, clearCaches, MODULES };
