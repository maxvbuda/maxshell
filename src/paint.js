'use strict';

const ansi = require('./ansi');

// Token colours come from the current theme.
function colorFor(cls) {
  const theme = require('./theme');
  return theme.style(theme.current().syntax[cls]);
}

// Paints columns [from, to) of a tokenised line. `ranges` are [start, end)
// column pairs shown in reverse video (selections, bracket pairs, matches).
function paintSpans(spans, from, to, ranges = []) {
  const marked = (i) => {
    for (const [a, b] of ranges) if (i >= a && i < b) return true;
    return false;
  };

  let out = '';
  let col = 0;
  let curColor = null;
  let curMark = null;

  outer:
  for (const span of spans) {
    const color = colorFor(span.cls);
    for (const ch of span.text) {
      const i = col++;
      if (i < from) continue;
      if (i >= to) break outer;
      const mark = marked(i);
      if (color !== curColor || mark !== curMark) {
        out += ansi.reset();
        if (mark) out += ansi.reverse();
        out += color;
        curColor = color;
        curMark = mark;
      }
      out += ch;
    }
  }

  if (curColor !== null || curMark) out += ansi.reset();
  return out;
}

module.exports = { colorFor, paintSpans };
