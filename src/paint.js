'use strict';

const ansi = require('./ansi');

// One palette for every language, keyed by token class.
function colorFor(cls) {
  switch (cls) {
    case 'kw': return ansi.bold() + ansi.fg('magenta');
    case 'const': return ansi.fg(213);
    case 'builtin': return ansi.fg('cyan');
    case 'str': return ansi.fg('yellow');
    case 'num': return ansi.fg('green');
    case 'comment': return ansi.fg('gray');
    case 'decorator': return ansi.fg(214);
    case 'defname': return ansi.bold() + ansi.fg('blue');
    case 'op': return ansi.fg(252);
    case 'key': return ansi.fg(75);
    case 'var': return ansi.fg(81);
    case 'heading': return ansi.bold() + ansi.fg(75);
    case 'emph': return ansi.bold() + ansi.fg(223);
    case 'code': return ansi.fg(180);
    case 'link': return ansi.underline() + ansi.fg(111);
    case 'quote': return ansi.fg(245);
    case 'bullet': return ansi.fg(214);
    default: return '';
  }
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
