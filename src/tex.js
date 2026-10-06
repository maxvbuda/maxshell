'use strict';

// TeX math as plain Unicode text, for a terminal (aig's Gemma writes math in
// $…$): \frac{a}{b} → a/b, \sqrt{x} → √x, x^2 → x², a_1 → a₁, \alpha → α,
// \pm → ±, \le → ≤ … Commands it doesn't know keep their name without the
// backslash. Display math with \\ rows (aligned, cases, matrices) comes out
// one row per line, from texLines.

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
  Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫', approx: '≈', equiv: '≡',
  sim: '∼', simeq: '≃', cong: '≅', propto: '∝', infty: '∞', partial: '∂', nabla: '∇',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', to: '→', rightarrow: '→', leftarrow: '←',
  gets: '←', Rightarrow: '⇒', Leftarrow: '⇐', implies: '⇒', iff: '⇔', Leftrightarrow: '⇔',
  leftrightarrow: '↔', mapsto: '↦', uparrow: '↑', downarrow: '↓', in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
  emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧',
  wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗', angle: '∠', perp: '⊥', parallel: '∥',
  mid: '∣', degree: '°', prime: '′', ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
  hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', langle: '⟨', rangle: '⟩', lfloor: '⌊',
  rfloor: '⌋', lceil: '⌈', rceil: '⌉', therefore: '∴', because: '∵', checkmark: '✓',
  quad: '  ', qquad: '    ', ' ': ' ', ',': ' ', ':': ' ', ';': ' ', '!': '', '\\': '\n',
  '{': '{', '}': '}', '%': '%', $: '$', '&': '&', '#': '#', _: '_', '|': '‖', lbrace: '{', rbrace: '}',
  vert: '|', Vert: '‖', backslash: '\\',
};
// Named functions, written upright: \sin x → sin x.
const FUNCS = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh',
  'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'deg',
  'dim', 'ker', 'arg', 'Pr', 'mod', 'bmod']);
// Commands that only change the look; their argument is kept.
const KEEP = new Set(['text', 'textrm', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathsf',
  'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'operatorname', 'boldsymbol', 'bm', 'mbox', 'emph',
  'overline', 'underline', 'vec', 'mathring', 'displaystyle', 'textstyle', 'boxed']);
// Dropped: sizing and spacing.
const DROP = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
  'biggl', 'biggr', 'limits', 'nolimits', 'displaystyle', 'textstyle', 'scriptstyle', 'middle']);
// Accents over one letter, as combining marks.
const ACCENTS = { hat: '̂', widehat: '̂', bar: '̄', tilde: '̃', widetilde: '̃', dot: '̇', ddot: '̈' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ',
  p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ', '°': '°', '′': '′', '∘': '°', '*': '*', ' ': '' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ', ' ': '' };

// Text that reads as one thing without brackets: a/b, not (a+b)/c.
const simple = (s) => /^[√∛∜]?[\p{L}\p{N}.′°²³¹⁰-⁹ⁿ₀-₉∞]+$/u.test(s) || /^[\p{L}\p{N}]*\(.*\)$/u.test(s) && !/\).*\(/.test(s);
const wrap = (s) => (simple(s) ? s : `(${s})`);

function script(text, map, mark) {
  const chars = [...text];
  if (chars.length && chars.every((c) => c in map)) return chars.map((c) => map[c]).join('');
  return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
}

class Reader {
  constructor(src) { this.s = src; this.i = 0; }

  // A {group}, a command or one character, converted.
  arg() {
    this.space();
    const c = this.s[this.i];
    if (c === undefined) return '';
    if (c === '{') return this.group();
    if (c === '\\') return this.command();
    this.i++;
    return c;
  }

  group() {
    this.i++; // {
    const out = this.until('}');
    this.i++;
    return out;
  }

  // [optional] argument, raw-converted, or null.
  optional() {
    this.space();
    if (this.s[this.i] !== '[') return null;
    this.i++;
    return this.until(']', true);
  }

  space() { while (this.s[this.i] === ' ') this.i++; }

  until(close, bracket = false) {
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== close) out += this.atom();
    if (bracket) this.i++;
    return out;
  }

  command() {
    const m = /^\\([a-zA-Z]+|.)/.exec(this.s.slice(this.i));
    if (!m) { this.i++; return ''; }
    this.i += m[0].length;
    const name = m[1];
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
      const a = this.arg().trim();
      const b = this.arg().trim();
      return `${wrap(a)}/${wrap(b)}`;
    }
    if (name === 'sqrt') {
      const n = this.optional();
      const x = this.arg().trim();
      const root = n === null ? '√' : n === '3' ? '∛' : n === '4' ? '∜' : `${script(n, SUP, '^')}√`;
      return `${root}${wrap(x)}`;
    }
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') return `C(${this.arg().trim()}, ${this.arg().trim()})`;
    if (name === 'pmod') return ` (mod ${this.arg().trim()})`;
    if (name === 'begin' || name === 'end') {
      const env = this.arg();
      this.env = name === 'begin' ? env : null;
      if (name === 'begin' && /array|tabular/.test(env) && this.s[this.i] === '{') this.arg();
      return '';
    }
    if (name in ACCENTS) {
      const x = this.arg();
      return [...x].length === 1 ? x + ACCENTS[name] : x;
    }
    if (KEEP.has(name)) return this.s[this.i] === '{' || !DROP.has(name) ? this.arg() : '';
    if (DROP.has(name)) { if ((name === 'left' || name === 'right') && this.s[this.i] === '.') this.i++; return ''; }
    if (FUNCS.has(name)) {
      if (name === 'bmod') return ' mod ';
      // lim_{x \to 0} → lim(x → 0)
      if (this.s[this.i] === '_' && /^(lim|max|min|sup|inf)$/.test(name)) { this.i++; return ` ${name}(${this.arg().trim()}) `; }
      return ` ${name}`; // 2x\cos x → 2x cos x
    }
    if (name in SYMBOLS) return SYMBOLS[name];
    return name;
  }

  atom() {
    const c = this.s[this.i];
    if (c === '{') return this.group();
    if (c === '\\') return this.command();
    if (c === '^' || c === '_') {
      this.i++;
      const x = this.arg();
      return script(x.trim(), c === '^' ? SUP : SUB, c);
    }
    if (c === '~') { this.i++; return ' '; }
    if (c === '&') { this.i++; return this.env === 'cases' ? ', ' : /matrix/.test(this.env || '') ? '  ' : ' '; }
    this.i++;
    return c;
  }

  all() {
    let out = '';
    while (this.i < this.s.length) out += this.atom();
    return out;
  }
}

const tidy = (s) => s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ,/g, ',').trim();

// Math as one line of text.
function texToText(src) {
  return tidy(new Reader(String(src)).all().replace(/\n/g, '; '));
}

// Display math: one string per \\ row.
function texLines(src) {
  return tidy(new Reader(String(src)).all()).split('\n').map((l) => l.trim()).filter(Boolean);
}

module.exports = { texToText, texLines };
