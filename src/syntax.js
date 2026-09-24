'use strict';

const path = require('path');

const py = require('./pyhighlight');
const { paintSpans } = require('./paint');

// Every tokenizer takes (line, state) and returns { spans, endState }, where
// joining the span texts gives back the line exactly. `state` carries
// constructs that span lines, such as block comments and fenced code.

function spanner() {
  const spans = [];
  const push = (text, cls) => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && last.cls === cls) last.text += text;
    else spans.push({ text, cls });
  };
  return { spans, push };
}

// Index just past a quoted string starting at `i`, honouring backslashes.
function scanQuoted(line, i, quote, escapes = true) {
  let j = i + 1;
  while (j < line.length) {
    if (escapes && line[j] === '\\') { j += 2; continue; }
    if (line[j] === quote) return { end: j + 1, closed: true };
    j++;
  }
  return { end: line.length, closed: false };
}

function scanNumber(line, i) {
  const m = /^(0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*\.?[\d_]*([eE][-+]?\d+)?n?)/.exec(line.slice(i));
  return m ? m[0].length : 1;
}

// --- JavaScript -------------------------------------------------------------

const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from',
  'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return',
  'set', 'static', 'super', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield',
]);
const JS_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);
const JS_BUILTINS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
  'Map', 'Set', 'WeakMap', 'Symbol', 'Date', 'RegExp', 'Error', 'TypeError', 'require',
  'module', 'exports', 'process', 'Buffer', 'globalThis', 'window', 'document',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat',
]);

function tokenizeJs(line, state = null) {
  const { spans, push } = spanner();
  let i = 0;

  if (state && state.kind === 'block') {
    const end = line.indexOf('*/');
    if (end === -1) { push(line, 'comment'); return { spans, endState: state }; }
    push(line.slice(0, end + 2), 'comment');
    i = end + 2;
  } else if (state && state.kind === 'template') {
    const { end, closed } = scanQuoted(`\0${line}`, 0, '`');
    push(line.slice(0, end - 1), 'str');
    if (!closed) return { spans, endState: state };
    i = end - 1;
  }

  let prevWord = null;
  while (i < line.length) {
    const c = line[i];
    const rest = line.slice(i);

    if (rest.startsWith('//')) { push(rest, 'comment'); break; }
    if (rest.startsWith('/*')) {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) { push(rest, 'comment'); return { spans, endState: { kind: 'block' } }; }
      push(line.slice(i, end + 2), 'comment');
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const { end } = scanQuoted(line, i, c);
      push(line.slice(i, end), 'str');
      i = end;
      continue;
    }
    if (c === '`') {
      const { end, closed } = scanQuoted(line, i, '`');
      push(line.slice(i, end), 'str');
      if (!closed) return { spans, endState: { kind: 'template' } };
      i = end;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const n = scanNumber(line, i);
      push(line.slice(i, i + n), 'num');
      i += n;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
      const word = m[0];
      let cls = 'plain';
      if (prevWord === 'function' || prevWord === 'class') cls = 'defname';
      else if (JS_KEYWORDS.has(word)) cls = 'kw';
      else if (JS_CONSTANTS.has(word)) cls = 'const';
      else if (JS_BUILTINS.has(word)) cls = 'builtin';
      push(word, cls);
      prevWord = word;
      i += word.length;
      continue;
    }
    if (c === ' ' || c === '\t') { push(c, 'plain'); i++; continue; }
    push(c, 'op');
    i++;
  }
  return { spans, endState: null };
}

// --- shell ------------------------------------------------------------------

const SH_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'for', 'foreach', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'select', 'repeat', 'end', 'time',
]);
const SH_BUILTINS = new Set([
  'echo', 'print', 'printf', 'cd', 'pwd', 'export', 'local', 'typeset', 'declare',
  'unset', 'return', 'exit', 'source', 'alias', 'unalias', 'read', 'test', 'set',
  'shift', 'eval', 'let', 'type', 'which', 'whence', 'history', 'true', 'false',
  'break', 'continue', 'pushd', 'popd', 'dirs', 'command', 'pyedit', 'edit', 'view',
  'files', 'top',
]);
const SH_RESET = new Set(['then', 'do', 'else', 'elif', 'time', '!']);

function scanExpansion(line, i) {
  const next = line[i + 1];
  if (next === '{' || next === '(') {
    const open = next;
    const close = open === '{' ? '}' : ')';
    let depth = 0;
    for (let j = i + 1; j < line.length; j++) {
      if (line[j] === open) depth++;
      else if (line[j] === close && --depth === 0) return j + 1;
    }
    return line.length;
  }
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(line.slice(i));
  return m ? i + m[0].length : i + 1;
}

function tokenizeShell(line) {
  const { spans, push } = spanner();
  let i = 0;
  let commandSlot = true;

  while (i < line.length) {
    const c = line[i];

    if (c === ' ' || c === '\t') { push(c, 'plain'); i++; continue; }

    if (c === '#' && (i === 0 || /[\s;|&(]/.test(line[i - 1]))) { push(line.slice(i), 'comment'); break; }

    if (c === "'") {
      const { end } = scanQuoted(line, i, "'", false);
      push(line.slice(i, end), 'str');
      i = end;
      commandSlot = false;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      push('"', 'str');
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\') { push(line.slice(j, j + 2), 'str'); j += 2; continue; }
        if (line[j] === '$') {
          const end = scanExpansion(line, j);
          push(line.slice(j, end), 'var');
          j = end;
          continue;
        }
        push(line[j], 'str');
        j++;
      }
      if (j < line.length) { push('"', 'str'); j++; }
      i = j;
      commandSlot = false;
      continue;
    }

    if (c === '$') {
      const end = scanExpansion(line, i);
      push(line.slice(i, end), 'var');
      i = end;
      commandSlot = false;
      continue;
    }

    if ('|&;(){}<>'.includes(c)) {
      push(c, 'op');
      if ('|&;({'.includes(c)) commandSlot = true;
      i++;
      continue;
    }

    const m = /^[^\s|&;(){}<>'"$#]+(#[^\s|&;(){}<>'"$]*)*/.exec(line.slice(i));
    const word = m ? m[0] : c;

    const assign = commandSlot && /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/.exec(word);
    if (assign) {
      push(assign[1], 'var');
      push(word.slice(assign[1].length), 'plain');
    } else if (SH_KEYWORDS.has(word)) {
      push(word, 'kw');
      commandSlot = SH_RESET.has(word) || word === 'if' || word === 'while' || word === 'until';
      i += word.length;
      continue;
    } else if (commandSlot && SH_BUILTINS.has(word)) {
      push(word, 'builtin');
      commandSlot = false;
    } else if (commandSlot) {
      push(word, 'defname');
      commandSlot = false;
    } else if (word.startsWith('-')) {
      push(word, 'decorator');
    } else if (/^\d+$/.test(word)) {
      push(word, 'num');
    } else {
      push(word, 'plain');
    }
    i += word.length;
  }
  return { spans, endState: null };
}

// --- JSON -------------------------------------------------------------------

function tokenizeJson(line) {
  const { spans, push } = spanner();
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      const { end } = scanQuoted(line, i, '"');
      const after = line.slice(end).trimStart();
      push(line.slice(i, end), after.startsWith(':') ? 'key' : 'str');
      i = end;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      const m = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(line.slice(i));
      const n = m ? m[0].length : 1;
      push(line.slice(i, i + n), 'num');
      i += n;
      continue;
    }
    const word = /^(true|false|null)\b/.exec(line.slice(i));
    if (word) { push(word[0], 'const'); i += word[0].length; continue; }
    push(c, /\s/.test(c) ? 'plain' : 'op');
    i++;
  }
  return { spans, endState: null };
}

// --- Markdown ---------------------------------------------------------------

function tokenizeInlineMarkdown(text, push) {
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = /^`[^`]*`/.exec(rest))) { push(m[0], 'code'); i += m[0].length; continue; }
    if ((m = /^(\*\*|__)(?=\S)(.+?)(?<=\S)\1/.exec(rest))) { push(m[0], 'emph'); i += m[0].length; continue; }
    if ((m = /^(\*|_)(?=\S)([^*_]+?)(?<=\S)\1/.exec(rest))) { push(m[0], 'emph'); i += m[0].length; continue; }
    if ((m = /^!?\[[^\]]*\]\([^)]*\)/.exec(rest))) { push(m[0], 'link'); i += m[0].length; continue; }
    if ((m = /^<https?:\/\/[^>]+>/.exec(rest))) { push(m[0], 'link'); i += m[0].length; continue; }
    push(text[i], 'plain');
    i++;
  }
}

function tokenizeMarkdown(line, state = null) {
  const { spans, push } = spanner();
  const fence = /^\s*(```|~~~)/.exec(line);

  if (state && state.kind === 'fence') {
    push(line, 'code');
    const closes = fence && fence[1] === state.fence;
    return { spans, endState: closes ? null : state };
  }
  if (fence) {
    push(line, 'code');
    return { spans, endState: { kind: 'fence', fence: fence[1] } };
  }
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) { push(line, 'heading'); return { spans, endState: null }; }
  if (/^\s*>/.test(line)) { push(line, 'quote'); return { spans, endState: null }; }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { push(line, 'op'); return { spans, endState: null }; }

  const bullet = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
  if (bullet) {
    push(bullet[1], 'plain');
    push(bullet[2], 'bullet');
    push(bullet[3], 'plain');
    tokenizeInlineMarkdown(line.slice(bullet[0].length), push);
  } else {
    tokenizeInlineMarkdown(line, push);
  }
  return { spans, endState: null };
}

function tokenizePlain(line) {
  return { spans: line ? [{ text: line, cls: 'plain' }] : [], endState: null };
}

// --- the language table -----------------------------------------------------

// `indentAfter` is tested against a line with its trailing comment removed.
// `closers` are characters that, typed at the start of a line, dedent it.
const LANGUAGES = {
  python: {
    id: 'python', name: 'Python', exts: ['.py', '.pyw', '.pyi'], shebang: /python/,
    comment: '#', indentAfter: /[:([{]$/, closers: ')]}', pairs: true,
    tokenize: py.tokenizeLine, run: 'python', check: 'python',
  },
  javascript: {
    id: 'javascript', name: 'JavaScript', exts: ['.js', '.mjs', '.cjs', '.jsx'], shebang: /node/,
    comment: '//', indentAfter: /[{[(]$/, closers: ')]}', pairs: true,
    tokenize: tokenizeJs, run: 'node', check: 'node',
  },
  shell: {
    id: 'shell', name: 'Shell', exts: ['.sh', '.bash', '.zsh', '.mxsh'], shebang: /\b(ba|z|k|max)?sh\b/,
    comment: '#', indentAfter: /(\b(then|do|else)|[{(])$/, closers: ')}', pairs: true,
    tokenize: tokenizeShell, run: 'maxshell', check: 'maxshell',
  },
  json: {
    id: 'json', name: 'JSON', exts: ['.json', '.jsonc', '.webmanifest'], shebang: null,
    comment: null, indentAfter: /[{[]$/, closers: ']}', pairs: true,
    tokenize: tokenizeJson, run: null, check: 'json',
  },
  markdown: {
    id: 'markdown', name: 'Markdown', exts: ['.md', '.markdown', '.mdx'], shebang: null,
    comment: null, indentAfter: null, closers: '', pairs: false,
    tokenize: tokenizeMarkdown, run: null, check: null,
  },
  plain: {
    id: 'plain', name: 'Text', exts: ['.txt'], shebang: null,
    comment: null, indentAfter: null, closers: '', pairs: false,
    tokenize: tokenizePlain, run: null, check: null,
  },
};

function languageById(id) {
  return LANGUAGES[id] || null;
}

// Picks a language from the file extension, then from a #! line.
function detectLanguage(filename, firstLine = '') {
  const ext = path.extname(filename || '').toLowerCase();
  for (const lang of Object.values(LANGUAGES)) {
    if (lang.exts.includes(ext)) return lang;
  }
  if (firstLine.startsWith('#!')) {
    for (const lang of Object.values(LANGUAGES)) {
      if (lang.shebang && lang.shebang.test(firstLine)) return lang;
    }
  }
  return LANGUAGES.plain;
}

// Guesses at text with no filename, e.g. something piped into `view`.
function sniffLanguage(text) {
  const trimmed = text.trimStart();
  if (/^[[{]/.test(trimmed)) {
    try { JSON.parse(text); return LANGUAGES.json; } catch { /* not JSON */ }
  }
  const first = trimmed.split('\n', 1)[0];
  if (first.startsWith('#!')) return detectLanguage('', first);
  if (/^#{1,6}\s/.test(first)) return LANGUAGES.markdown;
  return LANGUAGES.plain;
}

function computeStates(lang, lines) {
  const states = new Array(lines.length);
  let state = null;
  for (let i = 0; i < lines.length; i++) {
    states[i] = state;
    state = lang.tokenize(lines[i], state).endState;
  }
  return states;
}

function renderSlice(lang, line, state, from, to, ranges = []) {
  return paintSpans(lang.tokenize(line, state).spans, from, to, ranges);
}

module.exports = {
  LANGUAGES,
  languageById,
  detectLanguage,
  sniffLanguage,
  computeStates,
  renderSlice,
  tokenizeJs,
  tokenizeShell,
  tokenizeJson,
  tokenizeMarkdown,
  tokenizePlain,
};
