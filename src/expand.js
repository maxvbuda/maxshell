'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { lexWordParts, ShellError } = require('./lexer');
const { evalArith, evalArithString } = require('./arith');

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
  if (anchor === 'prefix') {
    for (let j = str.length; j >= 0; j--) if (re.test(str.slice(0, j))) return rep + str.slice(j);
    return str;
  }
  if (anchor === 'suffix') {
    for (let i = 0; i <= str.length; i++) if (re.test(str.slice(i))) return str.slice(0, i) + rep;
    return str;
  }
  let out = '';
  let i = 0;
  while (i <= str.length) {
    let matchedEnd = -1;
    for (let j = str.length; j > i; j--) {
      if (re.test(str.slice(i, j))) { matchedEnd = j; break; }
    }
    if (matchedEnd === -1) {
      if (i >= str.length) break;
      out += str[i];
      i++;
      continue;
    }
    out += rep;
    i = matchedEnd;
    if (!all) { out += str.slice(i); break; }
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

// Operators that test the value as a whole (an empty array counts as empty)
// rather than applying to each element.
const WHOLE_OPS = new Set([':-', '-', ':=', '=', ':+', '+', ':?', '?']);

function applyWholeOp(shell, p, v) {
  const arg = () => expandToString(shell, lexWordParts(p.argSrc ?? ''));
  const argList = () => {
    // ${x:-a b} keeps the default as one word, but ${arr:-$other} can be an array.
    const parts = lexWordParts(p.argSrc ?? '');
    if (parts.length === 1 && parts[0].t === 'param' && !parts[0].q) {
      const r = evalParam(shell, { ...parts[0], q: true });
      if (r.list) return r;
    }
    return { str: arg() };
  };
  const unset = v.unset;
  const empty = unset || (v.list ? v.list.length === 0 : v.str === '');
  const name = p.name || '';
  const assign = () => {
    const r = argList();
    if (r.list) shell.setVar(name, r.list.slice()); else shell.setVar(name, r.str);
    return r;
  };
  switch (p.op) {
    case ':-': return empty ? argList() : v;
    case '-': return unset ? argList() : v;
    case ':=': return empty ? assign() : v;
    case '=': return unset ? assign() : v;
    case ':+': return empty ? { str: '' } : argList();
    case '+': return unset ? { str: '' } : argList();
    case ':?':
      if (empty) throw new ShellError(`${name}: ${p.argSrc ? arg() : 'parameter null or not set'}`);
      return v;
    case '?':
      if (unset) throw new ShellError(`${name}: ${p.argSrc ? arg() : 'parameter not set'}`);
      return v;
    default: return v;
  }
}

function applyElementOp(shell, p, value) {
  const arg = () => expandToPattern(shell, lexWordParts(p.argSrc ?? ''));
  switch (p.op) {
    case '#': return trimPattern(value, arg(), 'prefix', false);
    case '##': return trimPattern(value, arg(), 'prefix', true);
    case '%': return trimPattern(value, arg(), 'suffix', false);
    case '%%': return trimPattern(value, arg(), 'suffix', true);
    case '/': case '//': case '/#': case '/%': {
      const [patSrc, repSrc] = splitReplacement(p.argSrc ?? '');
      const pat = expandToPattern(shell, lexWordParts(patSrc));
      const rep = repSrc === null ? '' : expandToString(shell, lexWordParts(repSrc));
      const anchor = p.op === '/#' ? 'prefix' : p.op === '/%' ? 'suffix' : null;
      return replacePattern(value, pat, rep, p.op === '//', anchor);
    }
    // bash's case operators, for the muscle memory: ${x^^} ${x,,} ${x^} ${x,}
    case '^^': return value.toUpperCase();
    case ',,': return value.toLowerCase();
    case '^': return value.charAt(0).toUpperCase() + value.slice(1);
    case ',': return value.charAt(0).toLowerCase() + value.slice(1);
    default: return value;
  }
}

function sliceOffset(shell, p, v) {
  const [offSrc, lenSrc] = splitTopLevel(p.argSrc ?? '', ':');
  // For $@ and $*, offset 1 is $1 (0 is $0), as in bash and zsh.
  const positional = (p.name === '@' || p.name === '*') && p.index === undefined && !p.inner;
  const seq = positional ? [shell.scriptName, ...v.list] : v.list ? v.list : [...(v.str ?? '')];
  let off = Math.trunc(evalArith(offSrc || '0', shell));
  if (off < 0) off = Math.max(0, seq.length + off);
  let out;
  if (lenSrc === undefined) out = seq.slice(off);
  else {
    const len = Math.trunc(evalArith(lenSrc || '0', shell));
    out = len < 0 ? seq.slice(off, seq.length + len) : seq.slice(off, off + len);
  }
  return v.list ? { list: out } : { str: out.join('') };
}

function splitTopLevel(src, sep) {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) return [src.slice(0, i), src.slice(i + 1)];
  }
  return [src, undefined];
}

// :h :t :r :e :a :A :l :u :q :Q :s/x/y/ on one string.
function applyModifier(shell, mod, str, state) {
  switch (mod.m) {
    case 't': {
      const parts = str.split('/');
      return parts.slice(-(mod.n || 1)).join('/');
    }
    case 'h': {
      if (mod.n) return str.split('/').slice(0, mod.n).join('/') || '/';
      if (!str.includes('/')) return '.';
      const h = str.replace(/\/+[^/]*$/, '');
      return h === '' ? '/' : h;
    }
    case 'r': return str.replace(/\.[^./]*$/, '');
    case 'e': { const m = /\.([^./]*)$/.exec(str); return m ? m[1] : ''; }
    case 'l': return str.toLowerCase();
    case 'u': case 'U': return str.toUpperCase();
    case 'a': return path.resolve(shell.cwd, str);
    case 'A': try { return fs.realpathSync(path.resolve(shell.cwd, str)); } catch { return path.resolve(shell.cwd, str); }
    case 'c': { const { findInPath } = require('./builtins'); return findInPath(str, shell) || str; }
    case 'q': return quoteWord(str);
    case 'Q': return unquoteWord(str);
    case 's': case '&': {
      if (mod.m === 's') state.lastSub = mod;
      const sub = state.lastSub;
      if (!sub) return str;
      const to = sub.to.replace(/\\&/g, '\u0000').replace(/&/g, sub.from).replace(/\u0000/g, '&');
      return mod.global || sub.global ? str.split(sub.from).join(to) : str.replace(sub.from, () => to);
    }
    default: return str;
  }
}

function quoteWord(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return s.replace(/[^A-Za-z0-9_@%+=:,./-]/g, (c) => (c === '\n' ? "$'\\n'" : `\\${c}`));
}

function unquoteWord(s) {
  const { Lexer } = require('./lexer');
  try {
    const lx = new Lexer(s, { wordMode: true });
    lx.readWord();
    return lx.tokens[0].parts.map((p) => (p.t === 'lit' ? p.v : '')).join('');
  } catch { return s; }
}

function caseFlag(f, s) {
  if (f === 'U') return s.toUpperCase();
  if (f === 'L') return s.toLowerCase();
  return s.toLowerCase().replace(/(^|[^A-Za-z0-9])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

// Looks up the subscript of an array: n, -n, a,b ranges, and the (i) (I)
// (r) (R) search flags. Returns a { str } or { list }.
function subscriptArray(shell, arr, index, q) {
  if (index === '@' || index === '*') return { list: arr.slice(), star: index === '*' };
  const flag = /^\(([iIrR])\)(.*)$/.exec(index);
  if (flag) {
    const pat = expandToPattern(shell, lexWordParts(flag[2]));
    const re = patternRegex(pat);
    const order = flag[1] === 'i' || flag[1] === 'r' ? arr.map((_, i) => i) : arr.map((_, i) => arr.length - 1 - i);
    const hit = order.find((i) => re.test(arr[i]));
    if (flag[1] === 'i' || flag[1] === 'I') return { str: String(hit === undefined ? (flag[1] === 'i' ? arr.length + 1 : 0) : hit + 1) };
    return { str: hit === undefined ? '' : arr[hit] };
  }
  const [aSrc, bSrc] = splitTopLevel(index, ',');
  const pos = (n) => (n < 0 ? arr.length + n + 1 : n);
  if (bSrc !== undefined) {
    const from = Math.max(1, pos(Math.trunc(evalArith(aSrc, shell))));
    const to = pos(Math.trunc(evalArith(bSrc, shell)));
    return { list: arr.slice(from - 1, Math.max(from - 1, to)) };
  }
  const n = Math.trunc(evalArith(index, shell));
  const i = pos(n);
  return { str: i >= 1 && i <= arr.length ? arr[i - 1] : undefined, unset: !(i >= 1 && i <= arr.length) };
}

function subscriptString(shell, str, index) {
  if (index === '@' || index === '*') return { str };
  const chars = [...str];
  const got = subscriptArray(shell, chars, index);
  if (got.list) return { str: got.list.join('') };
  if (/^\([iIrR]\)/.test(index)) return got;
  return { str: got.str ?? '' };
}

// Evaluates ${...} (or $name) to either { str } or { list }, plus flags for
// how the result should become words.
function evalParam(shell, p) {
  const flags = new Map((p.flags || []).map((f) => [f.f, f]));
  let v;

  // --- the base value -----------------------------------------------------
  if (p.inner) {
    if (p.inner.t === 'cmd') v = { str: shell.captureOutput(p.inner.src).replace(/\n+$/, '') };
    else if (p.inner.t === 'arith') v = { str: evalArithString(p.inner.src, shell) };
    else v = evalParam(shell, { ...p.inner, q: true, keepArray: true });
  } else if (p.name === '') {
    v = { unset: true, str: undefined };
  } else if (p.name === '@' || p.name === '*') {
    v = { list: shell.positional.slice(), star: p.name === '*' };
  } else {
    let name = p.name;
    if (flags.has('P')) name = shell.getVar(name) ?? '';
    const entry = shell.findEntry(name);
    const val = entry ? entry.value : undefined;
    if (val instanceof Map) v = { map: val };
    else if (Array.isArray(val)) v = { list: val.slice() };
    else {
      const sv = shell.getVar(name);
      v = sv === undefined ? { unset: true, str: undefined } : { str: sv };
    }
  }

  // (P): the value names the variable to use.
  if (flags.has('P') && p.inner && v.str !== undefined) {
    const entry = shell.findEntry(v.str);
    if (entry && entry.value instanceof Map) v = { map: entry.value };
    else if (entry && Array.isArray(entry.value)) v = { list: entry.value.slice() };
    else { const sv = shell.getVar(v.str); v = sv === undefined ? { unset: true } : { str: sv }; }
  }

  // ${+name}: 1 if set, else 0.
  if (p.isSet && p.index === undefined) return { str: v.unset ? '0' : '1' };

  // --- subscripts ---------------------------------------------------------
  for (const index of [p.index, p.subIndex]) {
    if (index === undefined || index === null) continue;
    if (v.map) {
      if (index === '@' || index === '*') v = { list: [...v.map.values()], star: index === '*', mapRef: v.map };
      else {
        const key = expandToString(shell, lexWordParts(index));
        const has = v.map.has(key);
        v = { str: has ? v.map.get(key) : undefined, unset: !has };
      }
    } else if (v.list) {
      const got = subscriptArray(shell, v.list, index);
      v = { ...got, unset: got.unset };
      if (got.list) v.star = got.star;
    } else if (!v.unset) {
      v = subscriptString(shell, v.str, index);
    }
    if (p.isSet) return { str: v.unset ? '0' : '1' };
  }
  if (p.isSet) return { str: v.unset ? '0' : '1' };

  // Associative arrays expand to their values; (k) gives keys, (kv) both.
  if (v.map || v.mapRef) {
    const m = v.map || v.mapRef;
    if (flags.has('k') && flags.has('v')) v = { list: [...m].flat(), star: v.star };
    else if (flags.has('k')) v = { list: [...m.keys()], star: v.star };
    else if (v.map) v = { list: [...m.values()] };
  }

  if (v.str === undefined && !v.list && !v.unset) v.str = '';
  if (v.unset && !p.op && shell.options.has('u') && p.name && !'@*#?$!-'.includes(p.name)) {
    throw new ShellError(`${p.name}: parameter not set`);
  }

  // --- operators ----------------------------------------------------------
  if (p.op) {
    if (WHOLE_OPS.has(p.op)) {
      v = applyWholeOp(shell, p, v);
    } else if (p.op === ':off') {
      v = sliceOffset(shell, p, v.unset ? { str: '' } : v);
    } else if (v.list) v = { ...v, list: v.list.map((x) => applyElementOp(shell, p, x)) };
    else v = { str: applyElementOp(shell, p, v.str ?? '') };
  }
  if (v.str === undefined && !v.list) v = { str: '' };

  // --- modifiers ----------------------------------------------------------
  if (p.mods) {
    const state = {};
    const each = (x) => p.mods.reduce((acc, m) => applyModifier(shell, m, acc, state), x);
    v = v.list ? { ...v, list: v.list.map(each) } : { str: each(v.str) };
  }

  // --- flags --------------------------------------------------------------
  const ifs = shell.getVar('IFS') ?? ' \t\n';
  const toList = () => (v.list ? v.list : [v.str]);
  if (flags.has('f')) v = { list: toList().join(' ').split('\n').filter((x, i, a) => !(x === '' && i === a.length - 1)) };
  if (flags.has('s')) {
    const sep = flags.get('s').args[0];
    v = { list: toList().flatMap((x) => (sep === '' ? [...x] : x.split(sep))).filter((x) => x !== '') };
  }
  if (flags.has('z')) v = { list: toList().flatMap((x) => shellWords(x)) };
  if (p.split || (flags.has('=') )) v = { list: toList().flatMap((x) => x.split(new RegExp(`[${escapeRe(ifs)}]+`))).filter((x) => x !== '') };
  if (flags.has('o') || flags.has('O') || flags.has('n') || flags.has('i')) {
    const list = toList().slice();
    const key = flags.has('i') ? (x) => x.toLowerCase() : (x) => x;
    if (flags.has('n')) list.sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    else list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    if (flags.has('O')) list.reverse();
    v = { list };
  }
  if (flags.has('u')) v = { list: [...new Set(toList())] };
  for (const f of ['U', 'L', 'C']) {
    if (flags.has(f)) v = v.list ? { ...v, list: v.list.map((x) => caseFlag(f, x)) } : { str: caseFlag(f, v.str) };
  }
  if (flags.has('j')) v = { str: toList().join(flags.get('j').args[0]) };
  if (flags.has('F')) v = { str: toList().join('\n') };
  for (const f of ['l', 'r']) {
    if (!flags.has(f)) continue;
    const [nSrc, fill1 = ' ', fill2] = flags.get(f).args;
    const width = Math.trunc(evalArith(nSrc || '0', shell));
    const padOne = (x) => {
      const chars = [...x];
      if (f === 'l') {
        if (chars.length >= width) return chars.slice(chars.length - width).join('');
        const room = width - chars.length;
        const head = fill2 !== undefined ? fill2.slice(-room) : '';
        const need = room - head.length;
        return (fill1.repeat(Math.ceil(need / fill1.length || 0)).slice(0, need)) + head + x;
      }
      if (chars.length >= width) return chars.slice(0, width).join('');
      const room = width - chars.length;
      const tail = fill2 !== undefined ? fill2.slice(0, room) : '';
      const need = room - tail.length;
      return x + tail + fill1.repeat(Math.ceil(need / fill1.length || 0)).slice(0, need);
    };
    v = v.list ? { ...v, list: v.list.map(padOne) } : { str: padOne(v.str) };
  }
  if (flags.has('q')) v = v.list ? { ...v, list: v.list.map(quoteWord) } : { str: quoteWord(v.str) };
  if (flags.has('Q')) v = v.list ? { ...v, list: v.list.map(unquoteWord) } : { str: unquoteWord(v.str) };

  // --- length -------------------------------------------------------------
  if (p.length) {
    if (v.list && !flags.has('c') && !flags.has('w')) return { str: String(v.list.length) };
    const text = v.list ? v.list.join(' ') : v.str;
    if (flags.has('w')) return { str: String(text.split(/\s+/).filter(Boolean).length) };
    return { str: String([...text].length) };
  }

  if (v.list && flags.has('@')) v.at = true;
  // Nested inside another ${...}: an array stays an array.
  if (p.keepArray) return v;
  // A quoted ${arr} or $* joins; "$@", "${arr[@]}" and (@) keep the elements.
  if (v.list && p.q && !v.at && (v.star || !(p.name === '@' || p.index === '@' || p.subIndex === '@'))) {
    return { str: v.list.join(ifs[0] ?? '') };
  }
  return v;
}

// Splits a string into words the way the shell would (for the (z) flag).
function shellWords(s) {
  const { Lexer } = require('./lexer');
  try {
    return new Lexer(s).tokenize().filter((t) => t.type !== 'EOF' && t.type !== 'NEWLINE').map((t) => t.value);
  } catch { return s.split(/\s+/).filter(Boolean); }
}

function expandParam(shell, p, frags) {
  const q = p.q;
  const v = evalParam(shell, p);
  const wordSplit = !q && shell.options.has('shwordsplit');
  const glob = !q && (p.globsubst || shell.options.has('globsubst'));
  // Unquoted: empty results vanish, and there's no splitting (zsh) unless
  // SH_WORD_SPLIT is on or you ask with ${=name}.
  const frag = (text) => ({ text, glob, split: !q, ifs: wordSplit ? undefined : '' });

  if (v.list) {
    if (v.list.length === 0) return;
    v.list.forEach((x, i) => {
      if (i) frags.push({ brk: true, rc: p.rcexpand });
      frags.push(q ? { text: x, glob: false, split: false } : frag(x));
    });
    return;
  }
  frags.push(q ? { text: v.str, glob: false, split: false } : frag(v.str));
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
      frags.push({ text: evalArithString(p.src, shell), glob: false, split: false });
    } else if (p.t === 'cmd') {
      const out = shell.captureOutput(p.src).replace(/\n+$/, '');
      frags.push({ text: out, glob: !p.q && shell.options.has('globsubst'), split: !p.q });
    } else if (p.t === 'param') {
      expandParam(shell, p, frags);
    } else if (p.t === 'procsub') {
      frags.push({ text: shell.processSubstitution(p), glob: false, split: false });
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
    const seps = f.ifs ?? ifs;
    for (const ch of f.text) {
      if (seps.includes(ch)) {
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

// A trailing (…) of qualifier letters: *(.) files, *(/) folders, *(@)
// links, *(*) executables, *(N) no error when nothing matches, *(D) dot
// files too, ^ negates, o/O sort (n name, m modified, L size), [a,b] picks.
function splitQualifiers(chars) {
  if (!chars.length || chars[chars.length - 1].ch !== ')' || !chars[chars.length - 1].glob) return null;
  let depth = 0;
  let open = -1;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i].ch === ')') depth++;
    else if (chars[i].ch === '(') { depth--; if (depth === 0) { open = i; break; } }
  }
  if (open <= 0) return null;
  const body = chars.slice(open + 1, -1).map((c) => c.ch).join('');
  if (!/^(\^?[./@*=prwxRWXNDFUG-]|o[nmLa]|O[nmLa]|\[-?\d+(,-?\d+)?\])*$/.test(body) || body.includes('|')) return null;
  return { pattern: chars.slice(0, open), quals: body };
}

function applyQualifiers(list, quals, cwd) {
  const abs = (b) => (path.isAbsolute(b) ? b : path.resolve(cwd, b));
  const stat = (b, link) => { try { return link ? fs.lstatSync(abs(b)) : fs.statSync(abs(b)); } catch { return null; } };
  let out = list;
  let sort = null;
  let pick = null;
  let neg = false;
  for (let i = 0; i < quals.length; i++) {
    const c = quals[i];
    if (c === '^') { neg = !neg; continue; }
    if (c === 'o' || c === 'O') { sort = { by: quals[++i], rev: c === 'O' }; continue; }
    if (c === '[') {
      const end = quals.indexOf(']', i);
      const [x, y] = quals.slice(i + 1, end).split(',').map(Number);
      pick = [x, y ?? x];
      i = end;
      continue;
    }
    if ('ND-'.includes(c)) continue;
    const test = {
      '.': (b) => { const st = stat(b); return !!st && st.isFile(); },
      '/': (b) => { const st = stat(b); return !!st && st.isDirectory(); },
      '@': (b) => { const st = stat(b, true); return !!st && st.isSymbolicLink(); },
      '=': (b) => { const st = stat(b); return !!st && st.isSocket(); },
      p: (b) => { const st = stat(b); return !!st && st.isFIFO(); },
      '*': (b) => { const st = stat(b); return !!st && st.isFile() && (st.mode & 0o111) !== 0; },
      r: (b) => { const st = stat(b); return !!st && (st.mode & 0o400) !== 0; },
      w: (b) => { const st = stat(b); return !!st && (st.mode & 0o200) !== 0; },
      x: (b) => { const st = stat(b); return !!st && (st.mode & 0o100) !== 0; },
      R: (b) => { const st = stat(b); return !!st && (st.mode & 0o004) !== 0; },
      W: (b) => { const st = stat(b); return !!st && (st.mode & 0o002) !== 0; },
      X: (b) => { const st = stat(b); return !!st && (st.mode & 0o001) !== 0; },
      U: (b) => { const st = stat(b); return !!st && st.uid === process.getuid(); },
      G: (b) => { const st = stat(b); return !!st && st.gid === process.getgid(); },
      F: (b) => { const st = stat(b); try { return !!st && st.isDirectory() && fs.readdirSync(abs(b)).length > 0; } catch { return false; } },
    }[c];
    if (test) { const n = neg; out = out.filter((b) => test(b) !== n); }
    neg = false;
  }
  if (sort) {
    const key = {
      n: (b) => b,
      m: (b) => -((stat(b) || {}).mtimeMs || 0),
      a: (b) => -((stat(b) || {}).atimeMs || 0),
      L: (b) => (stat(b) || {}).size || 0,
    }[sort.by] || ((b) => b);
    out = out.slice().sort((a, b) => { const x = key(a); const y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
    if (sort.rev) out.reverse();
  }
  if (pick) {
    const n = out.length;
    const at = (k) => (k < 0 ? n + k + 1 : k);
    out = out.slice(at(pick[0]) - 1, at(pick[1]));
  }
  return out;
}

function globField(frags, cwd, shell) {
  const literal = frags.map((f) => f.text).join('');
  const opt = (name) => !!shell && shell.options.has(name);

  let chars = [];
  for (const f of frags) for (const ch of f.text) chars.push({ ch, glob: f.glob });
  const quals = splitQualifiers(chars);
  if (quals) chars = quals.pattern;
  const isGlobChar = (c, i, arr) => c.glob && ('*?['.includes(c.ch) || (c.ch === '(' && arr.slice(i).some((d) => d.glob && d.ch === '|')));
  if (!quals && !chars.some(isGlobChar)) return [literal];

  const segs = [];
  let cur = [];
  for (const c of chars) {
    if (c.ch === '/') { segs.push(cur); cur = []; } else cur.push(c);
  }
  segs.push(cur);

  const absolute = segs.length > 1 && segs[0].length === 0;
  let bases = absolute ? ['/'] : [''];
  const dots = opt('globdots') || (quals && quals.quals.includes('D'));

  for (let i = absolute ? 1 : 0; i < segs.length; i++) {
    const seg = segs[i];
    const segStr = seg.map((c) => c.ch).join('');
    const isLast = i === segs.length - 1;
    const isGlob = seg.some(isGlobChar);
    const next = [];

    if (!isGlob) {
      for (const b of bases) next.push(joinSeg(b, segStr));
      bases = next;
      continue;
    }

    if (segStr === '**' || segStr === '***') {
      for (const b of bases) next.push(...descendantDirs(cwd, b));
      bases = next;
      continue;
    }

    const re = patternRegex(seg.map((c) => (c.glob ? c.ch : `\\${c.ch}`)).join(''));
    for (const b of bases) {
      const abs = b === '' ? cwd : (path.isAbsolute(b) ? b : path.resolve(cwd, b));
      for (const e of listDir(abs)) {
        if (e.name.startsWith('.') && segStr[0] !== '.' && !dots) continue;
        if (!re.test(e.name)) continue;
        if (!isLast && !e.isDirectory() && !e.isSymbolicLink()) continue;
        next.push(joinSeg(b, e.name));
      }
    }
    bases = next.sort();
  }

  let found = bases.filter((b) => {
    if (b === '') return false;
    const abs = path.isAbsolute(b) ? b : path.resolve(cwd, b);
    try { fs.lstatSync(abs); return true; } catch { return false; }
  });
  if (quals) found = applyQualifiers(found, quals.quals, cwd);
  if (found.length) return found;
  if (opt('nullglob') || (quals && quals.quals.includes('N'))) return [];
  if (opt('nomatch')) throw new ShellError(`no matches found: ${literal}`);
  return [literal];
}

// --- brace expansion ------------------------------------------------------

// {a,b,c} and {1..10..2} / {a..e} / {01..10}, on unquoted text only.
function braceExpand(parts) {
  // Flatten into items: single unquoted characters, or whole other parts.
  const items = [];
  for (const p of parts) {
    if (p.t === 'lit' && !p.q) for (const ch of p.v) items.push({ ch });
    else items.push({ part: p });
  }
  const rebuild = (list) => {
    const out = [];
    for (const it of list) {
      if (it.part) { out.push(it.part); continue; }
      const prev = out[out.length - 1];
      if (prev && prev.t === 'lit' && !prev.q && prev._b) prev.v += it.ch;
      else out.push({ t: 'lit', v: it.ch, q: false, _b: true });
    }
    return out.map((p) => (p._b ? { t: 'lit', v: p.v, q: false } : p));
  };

  for (let i = 0; i < items.length; i++) {
    if (items[i].ch !== '{') continue;
    // Find the matching close and the top-level commas.
    let depth = 0;
    const commas = [];
    let close = -1;
    for (let j = i; j < items.length; j++) {
      const c = items[j].ch;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { close = j; break; } } else if (c === ',' && depth === 1) commas.push(j);
    }
    if (close === -1) return [parts];
    const before = items.slice(0, i);
    const after = items.slice(close + 1);
    let alternatives = null;
    if (commas.length) {
      alternatives = [];
      let start = i + 1;
      for (const c of [...commas, close]) {
        // An empty alternative still makes a word: {,x} gives '' and x.
        alternatives.push([...items.slice(start, c), { part: { t: 'lit', v: '', q: true } }]);
        start = c + 1;
      }
    } else {
      const inner = items.slice(i + 1, close);
      if (inner.every((it) => it.ch !== undefined)) {
        const seq = braceSequence(inner.map((it) => it.ch).join(''));
        if (seq) alternatives = seq.map((x) => [...x].map((ch) => ({ part: { t: 'lit', v: ch, q: true } })));
      }
    }
    if (!alternatives) continue;
    const out = [];
    for (const alt of alternatives) out.push(...braceExpand(rebuild([...before, ...alt, ...after])));
    return out;
  }
  return [parts];
}

function braceSequence(body) {
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const step = Math.abs(Number(m[3] || 1)) || 1;
    const width = /^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2]) ? Math.max(m[1].length, m[2].length) : 0;
    const dir = a <= b ? 1 : -1;
    const out = [];
    for (let n = a; dir > 0 ? n <= b : n >= b; n += step * dir) {
      const neg = n < 0;
      out.push((neg ? '-' : '') + String(Math.abs(n)).padStart(width - (neg ? 1 : 0), '0'));
      if (out.length > 100000) break;
    }
    return m[3] && Number(m[3]) < 0 ? out.reverse() : out;
  }
  m = /^(.)\.\.(.)$/u.exec(body);
  if (m) {
    const a = m[1].codePointAt(0);
    const b = m[2].codePointAt(0);
    const out = [];
    for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? 1 : -1) out.push(String.fromCodePoint(n));
    return out;
  }
  return null;
}

// ${^arr}: each element combines with the text around it, like braces.
function rcExpand(shell, parts) {
  const idx = parts.findIndex((p) => p.t === 'param' && p.rcexpand);
  if (idx === -1) return [parts];
  const v = evalParam(shell, { ...parts[idx], rcexpand: false, q: true, keepArray: true });
  const list = v.list || [v.str ?? ''];
  const out = [];
  for (const x of list) out.push(...rcExpand(shell, [...parts.slice(0, idx), { t: 'lit', v: x, q: true }, ...parts.slice(idx + 1)]));
  return out;
}

// --- public API -------------------------------------------------------------

function expandWord(shell, word, opts = {}) {
  let variants = [partsOf(word)];
  if (opts.braces !== false && !shell.options.has('ignorebraces')) variants = variants.flatMap(braceExpand);
  variants = variants.flatMap((parts) => rcExpand(shell, parts));
  if (variants.length > 1) {
    const out = [];
    for (const parts of variants) out.push(...expandOne(shell, parts, opts));
    return out;
  }
  return expandOne(shell, variants[0], opts);
}

function expandOne(shell, parts, opts) {
  const frags = expandParts(shell, parts, opts);

  if (opts.split === false) {
    return [frags.filter((f) => !f.brk).map((f) => f.text).join('')];
  }

  const ifs = shell.getVar('IFS') ?? ' \t\n';
  const fields = splitFields(frags, ifs);
  const out = [];
  for (const field of fields) {
    if (opts.glob === false || shell.options.has('noglob')) out.push(field.frags.map((f) => f.text).join(''));
    else out.push(...globField(field.frags, shell.cwd, shell));
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
