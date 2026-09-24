'use strict';

const { colorFor, paintSpans } = require('./paint');

const KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
  'with', 'yield', 'match', 'case',
]);

const CONSTANTS = new Set(['True', 'False', 'None', 'self', 'cls', '__name__']);

const BUILTINS = new Set([
  'abs', 'all', 'any', 'bin', 'bool', 'bytes', 'callable', 'chr', 'dict', 'dir',
  'divmod', 'enumerate', 'eval', 'filter', 'float', 'format', 'frozenset', 'getattr',
  'hasattr', 'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
  'len', 'list', 'map', 'max', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow',
  'print', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted',
  'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip',
]);

const STRING_PREFIX = /^[rRbBuUfF]{0,3}$/;

// Tokenises one line, carrying triple-quoted string state across lines.
// Returns { spans: [{ text, cls }], endState }.
function tokenizeLine(line, state = null) {
  const spans = [];
  let i = 0;
  let open = state;
  let prevWord = null;

  const push = (text, cls) => { if (text) spans.push({ text, cls }); };

  if (open) {
    const end = line.indexOf(open.delim);
    if (end === -1) {
      push(line, 'str');
      return { spans, endState: open };
    }
    push(line.slice(0, end + 3), 'str');
    i = end + 3;
    open = null;
  }

  while (i < line.length) {
    const c = line[i];

    if (c === '#') { push(line.slice(i), 'comment'); i = line.length; break; }

    if (c === ' ' || c === '\t') {
      let j = i;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
      push(line.slice(i, j), 'plain');
      i = j;
      continue;
    }

    if (c === '@' && spans.every((s) => s.cls === 'plain' && !s.text.trim())) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_.]/.test(line[j])) j++;
      push(line.slice(i, j), 'decorator');
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      const start = i;
      const triple = line.startsWith(c.repeat(3), i);
      const delim = triple ? c.repeat(3) : c;
      let j = i + delim.length;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line.startsWith(delim, j)) { j += delim.length; closed = true; break; }
        j++;
      }
      push(line.slice(start, closed ? j : line.length), 'str');
      if (!closed && triple) {
        return { spans, endState: { delim } };
      }
      i = closed ? j : line.length;
      continue;
    }

    if (/[0-9]/.test(c)) {
      const m = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?[\d_]*([eE][-+]?\d+)?[jJ]?)/.exec(line.slice(i));
      const text = m ? m[0] : c;
      push(text, 'num');
      i += text.length;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);

      // A string prefix like f"..." or rb'...' belongs to the string.
      if (STRING_PREFIX.test(word) && word.length <= 3 && (line[j] === '"' || line[j] === "'")) {
        i = j;
        push(word, 'str');
        // Re-run the string branch by rewinding to the quote.
        const quote = line[j];
        const triple = line.startsWith(quote.repeat(3), j);
        const delim = triple ? quote.repeat(3) : quote;
        let k = j + delim.length;
        let closed = false;
        while (k < line.length) {
          if (line[k] === '\\') { k += 2; continue; }
          if (line.startsWith(delim, k)) { k += delim.length; closed = true; break; }
          k++;
        }
        push(line.slice(j, closed ? k : line.length), 'str');
        if (!closed && triple) return { spans, endState: { delim } };
        i = closed ? k : line.length;
        continue;
      }

      let cls = 'plain';
      if (prevWord === 'def' || prevWord === 'class') cls = 'defname';
      else if (KEYWORDS.has(word)) cls = 'kw';
      else if (CONSTANTS.has(word)) cls = 'const';
      else if (BUILTINS.has(word)) cls = 'builtin';

      push(word, cls);
      prevWord = word;
      i = j;
      continue;
    }

    let j = i;
    while (j < line.length && /[^A-Za-z0-9_\s#'"]/.test(line[j])) j++;
    push(line.slice(i, j === i ? i + 1 : j), 'op');
    i = j === i ? i + 1 : j;
  }

  return { spans, endState: open };
}

// Incoming triple-quote state for every line in the file.
function computeStates(lines) {
  const states = new Array(lines.length);
  let state = null;
  for (let i = 0; i < lines.length; i++) {
    states[i] = state;
    state = tokenizeLine(lines[i], state).endState;
  }
  return states;
}

// Renders columns [from, to) of a line, preserving colour across the slice.
// `ranges` are [start, end) column pairs to show in reverse video, used for
// the selection and for matching-bracket highlighting.
function renderSlice(line, state, from, to, ranges = []) {
  return paintSpans(tokenizeLine(line, state).spans, from, to, ranges);
}

module.exports = { tokenizeLine, computeStates, renderSlice, colorFor, KEYWORDS, BUILTINS, CONSTANTS };
