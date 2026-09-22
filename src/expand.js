'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { lexWordParts, ShellError } = require('./lexer');
const { evalArith } = require('./arith');

function partsOf(word) {
  return Array.isArray(word) ? word : word.parts;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- pattern matching -------------------------------------------------------

const patternCache = new Map();

function patternToRegexSource(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') { out += escapeRe(pat[++i] ?? '\\'); continue; }
    if (c === '*') { out += '[\\s\\S]*'; continue; }
    if (c === '?') { out += '[\\s\\S]'; continue; }
    if (c === '(') { out += '(?:'; continue; }
    if (c === ')') { out += ')'; continue; }
    if (c === '|') { out += '|'; continue; }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pat[j] === '!' || pat[j] === '^') { neg = true; j++; }
      if (pat[j] === ']') j++;
      while (j < pat.length && pat[j] !== ']') j++;
      if (j >= pat.length) { out += '\\['; continue; }
      const body = pat.slice(neg ? i + 2 : i + 1, j).replace(/\\/g, '\\\\');
      out += `[${neg ? '^' : ''}${body}]`;
      i = j;
      continue;
    }
    out += escapeRe(c);
  }
  return out;
}

function patternRegex(pat) {
  let re = patternCache.get(pat);
  if (!re) {
    re = new RegExp(`^(?:${patternToRegexSource(pat)})$`);
    patternCache.set(pat, re);
  }
  return re;
}

function matchPattern(pattern, str) {
  return patternRegex(pattern).test(str);
}

function trimPattern(str, pat, side, longest) {
  const re = patternRegex(pat);
  const idx = [];
  for (let i = 0; i <= str.length; i++) idx.push(i);
  const order = side === 'prefix'
    ? (longest ? idx.slice().reverse() : idx)
    : (longest ? idx : idx.slice().reverse());
  for (const i of order) {
    if (side === 'prefix') {
      if (re.test(str.slice(0, i))) return str.slice(i);
    } else if (re.test(str.slice(i))) {
      return str.slice(0, i);
    }
  }
  return str;
}

function replacePattern(str, pat, rep, all, anchor) {
  const re = patternRegex(pat);
  let out = '';
  let i = 0;
  let replaced = false;
  while (i <= str.length) {
    if (anchor === 'suffix' && i !== 0) { out += str.slice(i); break; }
    let matchedEnd = -1;
    if (!replaced || all) {
      for (let j = str.length; j >= i; j--) {
        if (anchor === 'suffix' && j !== str.length) continue;
        if (re.test(str.slice(i, j))) { matchedEnd = j; break; }
      }
    }
    if (matchedEnd === -1) {
      if (i >= str.length) break;
      out += str[i];
      i++;
      continue;
    }
    out += rep;
    replaced = true;
    if (matchedEnd === i) {
      if (i >= str.length) break;
      out += str[i];
      i++;
    } else {
      i = matchedEnd;
    }
    if (anchor === 'prefix') { out += str.slice(i); break; }
  }
  return out;
}

// --- tilde ------------------------------------------------------------------

function expandTilde(text, shell) {
  const slash = text.indexOf('/');
  const spec = slash === -1 ? text.slice(1) : text.slice(1, slash);
  const rest = slash === -1 ? '' : text.slice(slash);
  let home;
  if (spec === '') home = shell.getVar('HOME') || os.homedir();
  else if (spec === '+') home = shell.cwd;
  else if (spec === '-') home = shell.getVar('OLDPWD') || shell.cwd;
  else {
    const guess = path.join(path.dirname(os.homedir()), spec);
    if (!fs.existsSync(guess)) return text;
    home = guess;
  }
  return home + rest;
}

// --- parameter expansion ----------------------------------------------------

function splitReplacement(raw) {
  let pat = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') { pat += c + (raw[i + 1] ?? ''); i++; continue; }
    if (c === '/') return [pat, raw.slice(i + 1)];
    pat += c;
  }
  return [pat, null];
}

function applyParamOp(shell, p, value) {
  const arg = () => expandToString(shell, lexWordParts(p.argSrc ?? ''));

  if (!p.op) {
    if (value === undefined && shell.options.has('u') && !'@*#?$!-'.includes(p.name)) {
      throw new ShellError(`${p.name}: parameter not set`);
    }
    return value ?? '';
  }

  const unset = value === undefined;
  const empty = unset || value === '';

  switch (p.op) {
    case ':-': return empty ? arg() : value;
    case '-': return unset ? arg() : value;
    case ':=': if (empty) { const v = arg(); shell.setVar(p.name, v); return v; } return value;
    case '=': if (unset) { const v = arg(); shell.setVar(p.name, v); return v; } return value;
    case ':+': return empty ? '' : arg();
    case '+': return unset ? '' : arg();
    case ':?':
      if (empty) throw new ShellError(`${p.name}: ${p.argSrc ? arg() : 'parameter not set or null'}`);
      return value;
    case '?':
      if (unset) throw new ShellError(`${p.name}: ${p.argSrc ? arg() : 'parameter not set'}`);
      return value;
    case '#': return trimPattern(value ?? '', arg(), 'prefix', false);
    case '##': return trimPattern(value ?? '', arg(), 'prefix', true);
    case '%': return trimPattern(value ?? '', arg(), 'suffix', false);
    case '%%': return trimPattern(value ?? '', arg(), 'suffix', true);
    case '/': case '//': case '/#': case '/%': {
      const [patSrc, repSrc] = splitReplacement(p.argSrc ?? '');
      const pat = expandToString(shell, lexWordParts(patSrc));
      const rep = repSrc === null ? '' : expandToString(shell, lexWordParts(repSrc));
      const anchor = p.op === '/#' ? 'prefix' : p.op === '/%' ? 'suffix' : null;
      return replacePattern(value ?? '', pat, rep, p.op === '//', anchor);
    }
    case ':off': {
      const [offSrc, lenSrc] = splitTopLevel(p.argSrc ?? '', ':');
      const s = value ?? '';
      let off = Math.trunc(evalArith(offSrc || '0', shell));
      if (off < 0) off = Math.max(0, s.length + off);
      if (lenSrc === undefined) return s.slice(off);
      const len = Math.trunc(evalArith(lenSrc || '0', shell));
      return len < 0 ? s.slice(off, s.length + len) : s.substr(off, len);
    }
    default: return value ?? '';
  }
}

function splitTopLevel(src, sep) {
  const idx = src.indexOf(sep);
  if (idx === -1) return [src, undefined];
  return [src.slice(0, idx), src.slice(idx + 1)];
}

function expandParam(shell, p, frags) {
  const q = p.q;
  const push = (text, split) => frags.push({ text, glob: !q, split: split && !q });

  let list = null;
  let value;

  if (p.name === '@' || p.name === '*') {
    list = shell.positional.slice();
  } else if (p.index !== null && p.index !== undefined) {
    const arr = shell.getArray(p.name);
    if (p.index === '@' || p.index === '*') {
      if (arr) list = arr.slice();
      else {
        const v = shell.getVar(p.name);
        list = v === undefined ? [] : [v];
      }
    } else if (arr) {
      // Arrays are 1-indexed, as in zsh; negative indices count from the end.
      const n = Math.trunc(evalArith(p.index, shell));
      value = n < 0 ? arr[arr.length + n] : arr[n - 1];
    } else if (p.bare) {
      // `$name[...]` where name is not an array: the brackets were a glob.
      const v = shell.getVar(p.name);
      if (v !== undefined) {
        push(v, true);
        frags.push({ text: p.bare, glob: !q, split: false });
        return;
      }
      value = undefined;
    } else {
      value = undefined;
    }
  } else {
    const arr = shell.getArray(p.name);
    if (arr) list = arr.slice();
    else value = shell.getVar(p.name);
  }

  if (p.length) {
    push(String(list ? list.length : (value ?? '').length), false);
    return;
  }

  if (list) {
    if (p.op) list = list.map((v) => applyParamOp(shell, p, v));
    if (list.length === 0) return;
    if (q) {
      if (p.name === '@') {
        list.forEach((v, i) => {
          if (i) frags.push({ brk: true });
          frags.push({ text: v, glob: false, split: false });
        });
        return;
      }
      push(list.join(' '), false);
      return;
    }
    list.forEach((v, i) => {
      if (i) frags.push({ brk: true });
      frags.push({ text: v, glob: true, split: true });
    });
    return;
  }

  push(applyParamOp(shell, p, value), true);
}

// --- word expansion ---------------------------------------------------------

function expandParts(shell, parts, opts = {}) {
  const frags = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.t === 'lit') {
      let v = p.v;
      if (!p.q && i === 0 && opts.tilde !== false && v.startsWith('~')) v = expandTilde(v, shell);
      frags.push({ text: v, glob: !p.q, split: false });
    } else if (p.t === 'arith') {
      frags.push({ text: String(evalArith(p.src, shell)), glob: false, split: false });
    } else if (p.t === 'cmd') {
      const out = shell.captureOutput(p.src).replace(/\n+$/, '');
      frags.push({ text: out, glob: !p.q, split: !p.q });
    } else if (p.t === 'param') {
      expandParam(shell, p, frags);
    }
  }
  return frags;
}

function splitFields(frags, ifs) {
  const fields = [];
  let cur = null;
  const ensure = () => {
    if (!cur) { cur = { frags: [], lit: false }; fields.push(cur); }
    return cur;
  };

  for (const f of frags) {
    if (f.brk) { ensure(); cur = null; continue; }
    if (!f.split) {
      const c = ensure();
      c.frags.push(f);
      c.lit = true;
      continue;
    }
    let buf = '';
    for (const ch of f.text) {
      if (ifs.includes(ch)) {
        if (buf) { ensure().frags.push({ text: buf, glob: f.glob }); buf = ''; }
        cur = null;
      } else {
        buf += ch;
      }
    }
    if (buf) ensure().frags.push({ text: buf, glob: f.glob });
  }

  return fields.filter((f) => f.lit || f.frags.length);
}

// --- globbing ---------------------------------------------------------------

function joinSeg(base, name) {
  if (base === '') return name;
  if (base === '/') return `/${name}`;
  return `${base}/${name}`;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function descendantDirs(cwd, base) {
  const out = [base];
  const queue = [base];
  while (queue.length) {
    const b = queue.shift();
    const abs = b === '' ? cwd : (path.isAbsolute(b) ? b : path.resolve(cwd, b));
    for (const e of listDir(abs)) {
      if (e.name.startsWith('.')) continue;
      if (!e.isDirectory()) continue;
      const next = joinSeg(b, e.name);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

function globField(frags, cwd) {
  const literal = frags.map((f) => f.text).join('');

  const chars = [];
  for (const f of frags) for (const ch of f.text) chars.push({ ch, glob: f.glob });
  if (!chars.some((c) => c.glob && '*?['.includes(c.ch))) return [literal];

  const segs = [];
  let cur = [];
  for (const c of chars) {
    if (c.ch === '/') { segs.push(cur); cur = []; } else cur.push(c);
  }
  segs.push(cur);

  const absolute = segs.length > 1 && segs[0].length === 0;
  let bases = absolute ? ['/'] : [''];

  for (let i = absolute ? 1 : 0; i < segs.length; i++) {
    const seg = segs[i];
    const segStr = seg.map((c) => c.ch).join('');
    const isLast = i === segs.length - 1;
    const isGlob = seg.some((c) => c.glob && '*?['.includes(c.ch));
    const next = [];

    if (!isGlob) {
      for (const b of bases) next.push(joinSeg(b, segStr));
      bases = next;
      continue;
    }

    if (segStr === '**') {
      for (const b of bases) next.push(...descendantDirs(cwd, b));
      bases = next;
      continue;
    }

    const re = patternRegex(seg.map((c) => (c.glob ? c.ch : `\\${c.ch}`)).join(''));
    for (const b of bases) {
      const abs = b === '' ? cwd : (path.isAbsolute(b) ? b : path.resolve(cwd, b));
      for (const e of listDir(abs)) {
        if (e.name.startsWith('.') && segStr[0] !== '.') continue;
        if (!re.test(e.name)) continue;
        if (!isLast && !e.isDirectory() && !e.isSymbolicLink()) continue;
        next.push(joinSeg(b, e.name));
      }
    }
    bases = next.sort();
  }

  const found = bases.filter((b) => {
    const abs = b === '' ? cwd : (path.isAbsolute(b) ? b : path.resolve(cwd, b));
    return fs.existsSync(abs);
  });
  return found.length ? found : [literal];
}

// --- public API -------------------------------------------------------------

function expandWord(shell, word, opts = {}) {
  const frags = expandParts(shell, partsOf(word), opts);

  if (opts.split === false) {
    return [frags.filter((f) => !f.brk).map((f) => f.text).join('')];
  }

  const ifs = shell.getVar('IFS') ?? ' \t\n';
  const fields = splitFields(frags, ifs);
  const out = [];
  for (const field of fields) {
    if (opts.glob === false) out.push(field.frags.map((f) => f.text).join(''));
    else out.push(...globField(field.frags, shell.cwd));
  }
  return out;
}

function expandWords(shell, words, opts) {
  const out = [];
  for (const w of words) out.push(...expandWord(shell, w, opts));
  return out;
}

function expandToString(shell, word, opts = {}) {
  return expandParts(shell, partsOf(word), opts)
    .filter((f) => !f.brk)
    .map((f) => f.text)
    .join('');
}

// Expands a word into a glob/case pattern, keeping quoted characters literal.
function expandToPattern(shell, word) {
  const frags = expandParts(shell, partsOf(word), {});
  let out = '';
  for (const f of frags) {
    if (f.brk) continue;
    out += f.glob ? f.text : f.text.replace(/[*?[\]\\()|]/g, (m) => `\\${m}`);
  }
  return out;
}

module.exports = {
  expandWord,
  expandWords,
  expandToString,
  expandToPattern,
  expandParts,
  matchPattern,
  patternRegex,
  globField,
};
