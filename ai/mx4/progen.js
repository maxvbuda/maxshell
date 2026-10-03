'use strict';

// Generated programs for mx4. A function is a pipeline of small steps —
// "keep the even numbers", "square each one", "add them up" — each with its
// English, its Python and its JavaScript. Pipelines combine into millions of
// different functions, described in many wordings, written in more than
// one style, with the real output for an example input. Because almost no
// two are alike, a model can't recite them: it has to learn what the words
// and the code mean. It also makes edit tasks (here's my code — change it),
// translations and bug fixes, which need reading the code in the message.
//
//   node ai/mx4/progen.js [n]   runs n generated programs in python3 and node
//                               and checks the outputs they print

const NUM_FILTERS = [
  { en: 'keeps the even numbers', py: (v) => `${v} % 2 == 0`, js: (v) => `${v} % 2 === 0`, f: (x) => x % 2 === 0 },
  { en: 'keeps the odd numbers', py: (v) => `${v} % 2 != 0`, js: (v) => `${v} % 2 !== 0`, f: (x) => x % 2 !== 0 },
  { en: 'keeps only the positive numbers', py: (v) => `${v} > 0`, js: (v) => `${v} > 0`, f: (x) => x > 0 },
  { en: 'drops the negative numbers', py: (v) => `${v} >= 0`, js: (v) => `${v} >= 0`, f: (x) => x >= 0 },
  { en: 'keeps the numbers bigger than {k}', k: [5, 10, 20, 50], py: (v, k) => `${v} > ${k}`, js: (v, k) => `${v} > ${k}`, f: (x, k) => x > k },
  { en: 'keeps the numbers smaller than {k}', k: [10, 25, 100], py: (v, k) => `${v} < ${k}`, js: (v, k) => `${v} < ${k}`, f: (x, k) => x < k },
  { en: 'keeps the numbers divisible by {k}', k: [3, 4, 5, 7], py: (v, k) => `${v} % ${k} == 0`, js: (v, k) => `${v} % ${k} === 0`, f: (x, k) => x % k === 0 },
  { en: 'removes every {k}', k: [0, 1, 7], py: (v, k) => `${v} != ${k}`, js: (v, k) => `${v} !== ${k}`, f: (x, k) => x !== k },
];
const NUM_MAPS = [
  { en: 'doubles each one', py: (v) => `${v} * 2`, js: (v) => `${v} * 2`, f: (x) => x * 2 },
  { en: 'squares each one', py: (v) => `${v} * ${v}`, js: (v) => `${v} * ${v}`, f: (x) => x * x },
  { en: 'triples each one', py: (v) => `${v} * 3`, js: (v) => `${v} * 3`, f: (x) => x * 3 },
  { en: 'adds {k} to each one', k: [1, 5, 10, 100], py: (v, k) => `${v} + ${k}`, js: (v, k) => `${v} + ${k}`, f: (x, k) => x + k },
  { en: 'subtracts {k} from each one', k: [1, 3, 10], py: (v, k) => `${v} - ${k}`, js: (v, k) => `${v} - ${k}`, f: (x, k) => x - k },
  { en: 'multiplies each one by {k}', k: [4, 5, 10], py: (v, k) => `${v} * ${k}`, js: (v, k) => `${v} * ${k}`, f: (x, k) => x * k },
  { en: 'takes the absolute value of each one', py: (v) => `abs(${v})`, js: (v) => `Math.abs(${v})`, f: (x) => Math.abs(x) },
  { en: 'cubes each one', py: (v) => `${v} ** 3`, js: (v) => `${v} ** 3`, f: (x) => x ** 3 },
  { en: 'negates each one', py: (v) => `-${v}`, js: (v) => `-${v}`, f: (x) => -x },
  { en: 'takes each one modulo {k}', k: [3, 10], py: (v, k) => `${v} % ${k}`, js: (v, k) => `((${v} % ${k}) + ${k}) % ${k}`, f: (x, k) => ((x % k) + k) % k },
];
// Steps on the whole list.
const NUM_LIST = [
  { en: 'sorts them from smallest to largest', py: (v) => `sorted(${v})`, js: (v) => `[...${v}].sort((a, b) => a - b)`, f: (l) => [...l].sort((a, b) => a - b) },
  { en: 'sorts them from largest to smallest', py: (v) => `sorted(${v}, reverse=True)`, js: (v) => `[...${v}].sort((a, b) => b - a)`, f: (l) => [...l].sort((a, b) => b - a) },
  { en: 'reverses the order', py: (v) => `${v}[::-1]`, js: (v) => `[...${v}].reverse()`, f: (l) => [...l].reverse() },
  { en: 'removes duplicates (keeping the first of each)', py: (v) => `list(dict.fromkeys(${v}))`, js: (v) => `[...new Set(${v})]`, f: (l) => [...new Set(l)] },
  { en: 'keeps the first {k}', k: [2, 3, 5], py: (v, k) => `${v}[:${k}]`, js: (v, k) => `${v}.slice(0, ${k})`, f: (l, k) => l.slice(0, k) },
  { en: 'drops the first {k}', k: [1, 2], py: (v, k) => `${v}[${k}:]`, js: (v, k) => `${v}.slice(${k})`, f: (l, k) => l.slice(k) },
];
// The last step: a single answer, or the list itself.
const NUM_ENDS = [
  { en: 'returns their sum', name: 'total', py: (v) => `sum(${v})`, js: (v) => `${v}.reduce((a, b) => a + b, 0)`, f: (l) => l.reduce((a, b) => a + b, 0) },
  { en: 'returns how many there are', name: 'count', py: (v) => `len(${v})`, js: (v) => `${v}.length`, f: (l) => l.length },
  { en: 'returns the biggest one (or None if there are none)', jsEn: 'returns the biggest one (or null if there are none)', name: 'biggest', py: (v) => `max(${v}) if ${v} else None`, js: (v) => `${v}.length ? Math.max(...${v}) : null`, f: (l) => (l.length ? Math.max(...l) : null) },
  { en: 'returns the smallest one (or None if there are none)', jsEn: 'returns the smallest one (or null if there are none)', name: 'smallest', py: (v) => `min(${v}) if ${v} else None`, js: (v) => `${v}.length ? Math.min(...${v}) : null`, f: (l) => (l.length ? Math.min(...l) : null) },
  { en: 'returns their product', name: 'product', py: (v) => `math.prod(${v})`, js: (v) => `${v}.reduce((a, b) => a * b, 1)`, f: (l) => l.reduce((a, b) => a * b, 1), needs: 'math' },
  { en: 'returns their average (0 if there are none)', name: 'average', py: (v) => `sum(${v}) / len(${v}) if ${v} else 0`, js: (v) => `${v}.length ? ${v}.reduce((a, b) => a + b, 0) / ${v}.length : 0`, f: (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0) },
  { en: 'returns the new list', name: 'list', py: (v) => v, js: (v) => v, f: (l) => l },
];

const TEXT_STEPS = [
  { en: 'makes it upper case', py: (v) => `${v}.upper()`, js: (v) => `${v}.toUpperCase()`, f: (s) => s.toUpperCase() },
  { en: 'makes it lower case', py: (v) => `${v}.lower()`, js: (v) => `${v}.toLowerCase()`, f: (s) => s.toLowerCase() },
  { en: 'reverses it', py: (v) => `${v}[::-1]`, js: (v) => `[...${v}].reverse().join('')`, f: (s) => [...s].reverse().join('') },
  { en: 'removes the spaces', py: (v) => `${v}.replace(" ", "")`, js: (v) => `${v}.replaceAll(' ', '')`, f: (s) => s.split(' ').join('') },
  { en: 'trims spaces from both ends', py: (v) => `${v}.strip()`, js: (v) => `${v}.trim()`, f: (s) => s.trim() },
  { en: 'replaces every "{a}" with "{b}"', ab: [['a', '4'], ['e', '3'], ['o', '0'], [' ', '_'], ['s', 'z']], py: (v, [a, b]) => `${v}.replace(${JSON.stringify(a)}, ${JSON.stringify(b)})`, js: (v, [a, b]) => `${v}.replaceAll(${JSON.stringify(a)}, ${JSON.stringify(b)})`, f: (s, [a, b]) => s.split(a).join(b) },
  { en: 'removes the vowels', py: (v) => `"".join(c for c in ${v} if c.lower() not in "aeiou")`, js: (v) => `${v}.replace(/[aeiou]/gi, '')`, f: (s) => s.replace(/[aeiou]/gi, '') },
  { en: 'capitalises the first letter of each word', py: (v) => `" ".join(w[:1].upper() + w[1:] for w in ${v}.split(" "))`, js: (v) => `${v}.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')`, f: (s) => s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') },
  { en: 'repeats it {k} times', k: [2, 3], py: (v, k) => `${v} * ${k}`, js: (v, k) => `${v}.repeat(${k})`, f: (s, k) => s.repeat(k) },
];
const TEXT_ENDS = [
  { en: 'returns the result', name: 'text', py: (v) => v, js: (v) => v, f: (s) => s },
  { en: 'returns its length', name: 'length', py: (v) => `len(${v})`, js: (v) => `${v}.length`, f: (s) => [...s].length },
  { en: 'returns how many vowels it has', name: 'vowels', py: (v) => `sum(1 for c in ${v}.lower() if c in "aeiou")`, js: (v) => `(${v}.match(/[aeiou]/gi) || []).length`, f: (s) => (s.match(/[aeiou]/gi) || []).length },
  { en: 'returns how many words it has', name: 'words', py: (v) => `len(${v}.split())`, js: (v) => `${v}.split(/\\s+/).filter(Boolean).length`, f: (s) => s.split(/\s+/).filter(Boolean).length },
  { en: 'returns how many times the letter "{c}" appears', c: ['a', 'e', 'l', 's', 't'], name: 'count', py: (v, c) => `${v}.lower().count(${JSON.stringify(c)})`, js: (v, c) => `${v}.toLowerCase().split(${JSON.stringify(c)}).length - 1`, f: (s, c) => s.toLowerCase().split(c).length - 1 },
  { en: 'returns its first word', name: 'first_word', py: (v) => `${v}.split()[0] if ${v}.split() else ""`, js: (v) => `${v}.split(/\\s+/).filter(Boolean)[0] || ''`, f: (s) => s.split(/\s+/).filter(Boolean)[0] || '' },
  { en: 'returns whether it reads the same backwards', name: 'is_palindrome', py: (v) => `${v} == ${v}[::-1]`, js: (v) => `${v} === [...${v}].reverse().join('')`, f: (s) => s === [...s].reverse().join('') },
];

const SAMPLE_TEXTS = ['hello world', 'The quick brown fox', 'maxshell is fun', 'level', 'Python and JavaScript', 'a man a plan', 'banana split', 'Good morning everyone', 'racecar', 'learn to code', '  spaced out  ', 'Snakes and ladders'];

const NUMBER_NAMES = ['numbers', 'nums', 'values', 'items', 'scores', 'data', 'xs'];
const TEXT_NAMES = ['text', 'word', 'sentence', 's', 'message', 'phrase'];

// --- building ---------------------------------------------------------------------------

function rng(rand) {
  const pick = (l) => l[Math.floor(rand() * l.length)];
  return { pick, chance: (p) => rand() < p, int: (a, b) => a + Math.floor(rand() * (b - a + 1)), rand };
}

const fill = (step, r) => {
  const s = { ...step };
  if (step.k) s.arg = r.pick(step.k);
  if (step.ab) s.arg = r.pick(step.ab);
  if (step.c) s.arg = r.pick(step.c);
  s.text = step.en.replace('{k}', s.arg).replace('{a}', s.arg?.[0]).replace('{b}', s.arg?.[1]).replace('{c}', s.arg);
  s.jsText = (step.jsEn || step.en).replace('{k}', s.arg);
  return s;
};

function numberSpec(r) {
  const steps = [];
  const n = r.pick([1, 1, 2, 2, 3]);
  for (let i = 0; i < n; i++) {
    const kind = r.pick(['filter', 'filter', 'map', 'map', 'list']);
    const pool = kind === 'filter' ? NUM_FILTERS : kind === 'map' ? NUM_MAPS : NUM_LIST;
    const step = fill(r.pick(pool), r);
    step.kind = kind;
    if (steps.some((x) => x.en === step.en)) continue;
    steps.push(step);
  }
  const end = fill(r.pick(NUM_ENDS), r);
  if (end.name === 'list' && steps.every((s) => s.kind === 'filter')) steps.push({ ...fill(r.pick(NUM_LIST), r), kind: 'list' });
  const input = Array.from({ length: r.int(5, 9) }, () => r.int(-9, 30));
  if (r.chance(0.3)) input.push(input[0]);
  return { type: 'numbers', steps, end, input, v: r.pick(NUMBER_NAMES) };
}

function textSpec(r) {
  const steps = [];
  const n = r.pick([0, 1, 1, 2]);
  for (let i = 0; i < n; i++) {
    const step = fill(r.pick(TEXT_STEPS), r);
    if (steps.some((x) => x.en === step.en)) continue;
    steps.push(step);
  }
  const end = fill(r.pick(TEXT_ENDS), r);
  if (!steps.length && end.name === 'text') steps.push(fill(r.pick(TEXT_STEPS), r));
  return { type: 'text', steps, end, input: r.pick(SAMPLE_TEXTS), v: r.pick(TEXT_NAMES) };
}

// What the program really returns for the example input.
function evaluate(spec) {
  let x = spec.input;
  for (const s of spec.steps) {
    if (spec.type === 'text') x = s.f(x, s.arg);
    else if (s.kind === 'filter') x = x.filter((n) => s.f(n, s.arg));
    else if (s.kind === 'map') x = x.map((n) => s.f(n, s.arg));
    else x = s.f(x, s.arg);
  }
  spec.lastLength = Array.isArray(x) ? x.length : null;
  return spec.end.f(x, spec.end.arg);
}

function fnName(spec, style) {
  const words = [];
  const tag = (s) => (s.kind === 'filter' ? (/even/.test(s.text) ? 'even' : /odd/.test(s.text) ? 'odd' : /positive|negative/.test(s.text) ? 'positive' : /bigger/.test(s.text) ? 'big' : /smaller/.test(s.text) ? 'small' : /divisible/.test(s.text) ? `multiples_of_${s.arg}` : 'filtered')
    : s.kind === 'map' ? (/squares/.test(s.text) ? 'squared' : /doubles/.test(s.text) ? 'doubled' : /triples/.test(s.text) ? 'tripled' : /cubes/.test(s.text) ? 'cubed' : /absolute/.test(s.text) ? 'absolute' : 'changed')
      : (/sorts/.test(s.text) ? 'sorted' : /reverses/.test(s.text) ? 'reversed' : /duplicates/.test(s.text) ? 'unique' : 'some'));
  if (spec.type === 'numbers') {
    words.push(spec.end.name === 'list' ? 'process' : spec.end.name);
    for (const s of spec.steps) words.push(tag(s));
  } else {
    words.push(spec.end.name === 'text' ? 'transform' : spec.end.name);
    if (spec.end.name === 'text' && spec.steps[0]) words.push(/upper/.test(spec.steps[0].text) ? 'upper' : /reverses/.test(spec.steps[0].text) ? 'reversed' : /vowels/.test(spec.steps[0].text) ? 'no_vowels' : 'text');
  }
  const name = [...new Set(words)].slice(0, 3).join('_');
  return style === 'js' ? name.replace(/_(\w)/g, (m, c) => c.toUpperCase()) : name;
}

function fmtPy(v) {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return `'${v}'`;
  if (Array.isArray(v)) return `[${v.map(fmtPy).join(', ')}]`;
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

function fmtJs(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v}'`;
  if (Array.isArray(v)) return `[ ${v.map(fmtJs).join(', ')} ]`.replace('[  ]', '[]');
  return String(v);
}

// Python prints a float like 4.0; an average that's whole still prints .0.
function pyValue(spec, value) {
  // Python's average is a float (4.0), except the 0 for an empty list.
  if (spec.end.name === 'average' && typeof value === 'number') return spec.lastLength === 0 ? '0' : Number.isInteger(value) ? `${value}.0` : String(value);
  return fmtPy(value);
}

function writePython(spec, style) {
  const v = spec.v;
  const name = fnName(spec, 'py');
  const lines = [];
  if (spec.end.needs === 'math') lines.push('import math', '', '');
  lines.push(`def ${name}(${v}):`);
  let cur = v;
  if (spec.type === 'numbers') {
    if (style === 'loop' && spec.steps.length && spec.steps.every((s) => s.kind !== 'list')) {
      lines.push('    result = []', `    for n in ${v}:`);
      let ind = '        ';
      let expr = 'n';
      for (const s of spec.steps) {
        if (s.kind === 'filter') { lines.push(`${ind}if ${s.py(expr, s.arg)}:`); ind += '    '; } else { lines.push(`${ind}n = ${s.py('n', s.arg)}`); }
      }
      lines.push(`${ind}result.append(n)`);
      cur = 'result';
    } else {
      for (const s of spec.steps) {
        const next = 'result';
        if (s.kind === 'filter') lines.push(`    ${next} = [n for n in ${cur} if ${s.py('n', s.arg)}]`);
        else if (s.kind === 'map') lines.push(`    ${next} = [${s.py('n', s.arg)} for n in ${cur}]`);
        else lines.push(`    ${next} = ${s.py(cur, s.arg)}`);
        cur = next;
      }
    }
  } else {
    for (const s of spec.steps) {
      lines.push(`    ${v} = ${s.py(v, s.arg)}`);
    }
    cur = v;
  }
  lines.push(`    return ${spec.end.py(cur, spec.end.arg)}`);
  const arg = spec.type === 'numbers' ? fmtPy(spec.input) : JSON.stringify(spec.input);
  lines.push('', '', `print(${name}(${arg}))`);
  return lines.join('\n');
}

function writeJs(spec, style) {
  const v = spec.v;
  const name = fnName(spec, 'js');
  const lines = [`function ${name}(${v}) {`];
  let cur = v;
  if (spec.type === 'numbers') {
    if (style === 'loop' && spec.steps.length && spec.steps.every((s) => s.kind !== 'list')) {
      lines.push('  const result = [];', `  for (let n of ${v}) {`);
      let ind = '    ';
      const closes = [];
      for (const s of spec.steps) {
        if (s.kind === 'filter') { lines.push(`${ind}if (${s.js('n', s.arg)}) {`); closes.push(ind); ind += '  '; } else lines.push(`${ind}n = ${s.js('n', s.arg)};`);
      }
      lines.push(`${ind}result.push(n);`);
      while (closes.length) lines.push(`${closes.pop()}}`);
      lines.push('  }');
      cur = 'result';
    } else {
      let chain = v;
      for (const s of spec.steps) {
        if (s.kind === 'filter') chain += `\n    .filter((n) => ${s.js('n', s.arg)})`;
        else if (s.kind === 'map') chain += `\n    .map((n) => ${s.js('n', s.arg)})`;
        else chain = s.js(chain, s.arg);
      }
      if (chain !== v) { lines.push(`  const result = ${chain};`); cur = 'result'; }
    }
  } else {
    let expr = v;
    for (const s of spec.steps) expr = s.js(expr.includes(' ') && !/^\w+\(/.test(expr) ? `(${expr})` : expr, s.arg);
    if (expr !== v) { lines.push(`  const result = ${expr};`); cur = 'result'; }
  }
  lines.push(`  return ${spec.end.js(cur, spec.end.arg)};`, '}', '');
  const arg = spec.type === 'numbers' ? `[${spec.input.join(', ')}]` : `'${spec.input}'`;
  lines.push(`console.log(${name}(${arg}));`);
  return lines.join('\n');
}

// Exactly what console.log prints (Node wraps long arrays over lines).
function jsValue(value) {
  if (typeof value === 'string') return value;
  return require('util').inspect(value);
}

// The same on one line, for the sentence after the code.
const oneLine = (printed) => printed.replace(/\s*\n\s*/g, ' ');

function pyPrinted(spec, value) {
  if (typeof value === 'string') return value;
  return pyValue(spec, value);
}

// --- conversations -----------------------------------------------------------------------

const ASK = [
  (lang, d) => `write a ${lang} function that ${d}`, (lang, d) => `can you write ${lang} code that ${d}?`, (lang, d) => `${lang}: a function that ${d}`,
  (lang, d) => `i need a ${lang} function which ${d}`, (lang, d) => `how do i write a function in ${lang} that ${d}?`,
  (lang, d) => `make a ${lang} function that ${d}`, (lang, d) => `write me some ${lang} that ${d}`, (lang, d) => `${lang} code: ${d}`,
  (lang, d) => `please write a function that ${d}, in ${lang}`, (lang, d) => `could you code a ${lang} function that ${d}`,
];

function describe(spec, lang) {
  const parts = spec.steps.map((s) => s.text);
  const endText = lang === 'JavaScript' ? spec.end.jsText : spec.end.text;
  const head = spec.type === 'numbers' ? 'takes a list of numbers' : 'takes a string';
  const all = [head, ...parts, endText];
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}

function explainSteps(spec, lang) {
  return spec.steps.map((s) => `${s.text.charAt(0).toUpperCase()}${s.text.slice(1)}`).concat([(lang === 'JavaScript' ? spec.end.jsText : spec.end.text).replace(/^returns/, 'Returns')]).join(', then ').replace(/, then ([^,]+)$/, ', and finally $1') + '.';
}

// Pipelines whose numbers grow past what JavaScript holds exactly (cubes
// of products...) are thrown away and drawn again.
function safe(spec) {
  let ok = true;
  const check = (v) => { if (typeof v === 'number' && Math.abs(v) > 1e15 || (typeof v === 'number' && !Number.isSafeInteger(Math.round(v)))) ok = false; if (Array.isArray(v)) v.forEach(check); };
  let x = spec.input;
  for (const st of spec.steps) {
    if (spec.type === 'text') break;
    if (st.kind === 'filter') x = x.filter((n) => st.f(n, st.arg));
    else if (st.kind === 'map') x = x.map((n) => st.f(n, st.arg));
    else x = st.f(x, st.arg);
    check(x);
  }
  check(evaluate(spec));
  return ok;
}

function programConversation(rand) {
  const r = rng(rand);
  let spec;
  do spec = r.chance(0.65) ? numberSpec(r) : textSpec(r); while (!safe(spec));
  const lang = r.chance(0.55) ? 'Python' : 'JavaScript';
  const style = r.chance(0.35) ? 'loop' : 'compact';
  const code = lang === 'Python' ? writePython(spec, style) : writeJs(spec, style);
  const value = evaluate(spec);
  const printed = lang === 'Python' ? pyPrinted(spec, value) : jsValue(value);
  const request = r.pick(ASK)(r.chance(0.3) ? lang.toLowerCase() : lang, describe(spec, lang));
  const fence = lang === 'Python' ? 'python' : 'javascript';
  const reply = `${r.pick(['', 'Here you go:\n\n', `Sure! In ${lang}:\n\n`, 'This does it:\n\n'])}\`\`\`${fence}\n${code}\n\`\`\`\n\nWith ${spec.type === 'numbers' ? `\`${fmtJs(spec.input).replace(/^\[ | \]$/g, (m) => m.trim())}\`` : `\`"${spec.input}"\``} it prints \`${oneLine(printed)}\`. ${explainSteps(spec, lang)}`;
  return { request, reply, code, lang, printed, spec };
}

// Edit tasks: the code is in the message; the reply changes it.
function editConversation(rand) {
  const r = rng(rand);
  let spec;
  do spec = numberSpec(r); while (!safe(spec));
  if (spec.steps.some((s) => s.kind === 'list')) spec.steps = spec.steps.filter((s) => s.kind !== 'list');
  const lang = r.chance(0.55) ? 'Python' : 'JavaScript';
  const fence = lang === 'Python' ? 'python' : 'javascript';
  const write = (s) => (lang === 'Python' ? writePython(s, 'compact') : writeJs(s, 'compact'));
  const before = write(spec);
  const kind = r.pick(['add', 'add', 'translate', 'bug']);
  if (kind === 'translate') {
    const other = lang === 'Python' ? 'JavaScript' : 'Python';
    const after = other === 'Python' ? writePython(spec, 'compact') : writeJs(spec, 'compact');
    const value = evaluate(spec);
    return {
      request: `${r.pick(['convert this to', 'can you rewrite this in', 'translate this into', 'how would this look in'])} ${other.toLowerCase()}:\n\n\`\`\`${fence}\n${before}\n\`\`\``,
      reply: `Here it is in ${other}:\n\n\`\`\`${other === 'Python' ? 'python' : 'javascript'}\n${after}\n\`\`\`\n\nIt prints the same thing: \`${oneLine(other === 'Python' ? pyPrinted(spec, value) : jsValue(value))}\`.`,
      code: after, lang: other, printed: other === 'Python' ? pyPrinted(spec, value) : jsValue(value),
    };
  }
  if (kind === 'bug' && spec.steps.length) {
    // Swap a comparison or operator so it gives the wrong answer; the reply fixes it.
    const i = r.int(0, spec.steps.length - 1);
    const broken = JSON.parse(JSON.stringify(spec.steps.map((s) => ({ en: s.en }))));
    void broken;
    const right = spec.steps[i];
    const wrongSpec = { ...spec, steps: spec.steps.map((s, j) => (j === i ? { ...s, py: (v, k) => s.py(v, k).replace(/==/, '!=').replace(/>/, '<').replace(/\* /, '+ '), js: (v, k) => s.js(v, k).replace(/===/, '!==').replace(/>/, '<').replace(/\* /, '+ ') } : s)) };
    const bad = write(wrongSpec);
    if (bad === before) return programConversation(rand);
    const value = evaluate(spec);
    return {
      request: `${r.pick(['this should', 'my function is supposed to', 'i want this to'])} ${describe(spec, lang).replace(/^takes/, 'take').replace(/keeps/g, 'keep').replace(/returns/g, 'return').replace(/doubles/g, 'double').replace(/squares/g, 'square').replace(/adds/g, 'add').replace(/drops/g, 'drop').replace(/removes/g, 'remove')} but it gives the wrong answer:\n\n\`\`\`${fence}\n${bad}\n\`\`\``,
      reply: `The step that ${right.text} is wrong — it should be \`${lang === 'Python' ? right.py('n', right.arg) : right.js('n', right.arg)}\`. Fixed:\n\n\`\`\`${fence}\n${before}\n\`\`\`\n\nNow it prints \`${oneLine(lang === 'Python' ? pyPrinted(spec, value) : jsValue(value))}\`.`,
      code: before, lang, printed: lang === 'Python' ? pyPrinted(spec, value) : jsValue(value),
    };
  }
  // Add a step.
  const step = fill(r.pick([...NUM_FILTERS, ...NUM_MAPS]), r);
  step.kind = NUM_FILTERS.some((f) => f.en === step.en) ? 'filter' : 'map';
  if (spec.steps.some((s) => s.en === step.en)) return programConversation(rand);
  const after = { ...spec, steps: [...spec.steps, step] };
  if (!safe(after)) return programConversation(rand);
  const code = write(after);
  const value = evaluate(after);
  return {
    request: `${r.pick(['can you change this so it also', 'make it also', 'update this so it', 'how do i make this also'])} ${step.text.replace(/^keeps/, 'keep').replace(/^drops/, 'drop').replace(/^removes/, 'remove').replace(/^(doubles|squares|triples|cubes|negates)/, (m) => m.slice(0, -1)).replace(/^(adds|subtracts|multiplies|takes)/, (m) => m.slice(0, -1))}?\n\n\`\`\`${fence}\n${before}\n\`\`\``,
    reply: `Add one more step before the result:\n\n\`\`\`${fence}\n${code}\n\`\`\`\n\nNow it prints \`${oneLine(lang === 'Python' ? pyPrinted(after, value) : jsValue(value))}\`.`,
    code, lang, printed: lang === 'Python' ? pyPrinted(after, value) : jsValue(value),
  };
}

if (require.main === module) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const n = Number(process.argv[2]) || 300;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progen-'));
  let bad = 0;
  const seen = new Set();
  // All programs of one language run in one process, each in its own
  // namespace, printing a marker between outputs.
  const batch = { Python: [], JavaScript: [] };
  for (let i = 0; i < n; i++) {
    const c = i % 3 === 2 ? editConversation(rand) : programConversation(rand);
    seen.add(c.code);
    batch[c.lang].push(c);
  }
  const py = batch.Python.map((c) => `exec(${JSON.stringify(c.code)}, {})\nprint("@@@")`).join('\n');
  const js = batch.JavaScript.map((c) => `(new Function(${JSON.stringify(c.code)}))();\nconsole.log("@@@");`).join('\n');
  fs.writeFileSync(path.join(dir, 'a.py'), py);
  fs.writeFileSync(path.join(dir, 'a.js'), js);
  for (const [lang, cmd, file] of [['Python', 'python3', 'a.py'], ['JavaScript', 'node', 'a.js']]) {
    const out = spawnSync(cmd, [path.join(dir, file)], { encoding: 'utf8', maxBuffer: 1e8 });
    if (out.status !== 0) { console.log(`${lang} crashed: ${out.stderr.split('\n').slice(-4).join(' | ')}`); bad++; continue; }
    const got = out.stdout.split('@@@\n');
    batch[lang].forEach((c, i) => {
      const printed = (got[i] || '').replace(/\n$/, '');
      if (printed !== c.printed) { bad++; if (bad <= 8) console.log(`✗ ${lang}: expected ${JSON.stringify(c.printed)} got ${JSON.stringify(printed)}\n${c.code}\n`); }
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${n} programs, ${seen.size} different, ${bad} wrong`);
}

module.exports = { programConversation, editConversation };
