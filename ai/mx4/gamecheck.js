'use strict';

// Plays a web page's scripts in a fake browser: every element, canvas and
// event exists, nothing is drawn. The page is loaded, its timers and
// animation frames run a few hundred times, and keys, clicks and form
// submits are sent to every listener. Any error thrown is a failed check.
// It catches the bugs that matter in generated games — typos, missing
// variables, wrong method names — without a real browser.
//
//   const problem = playCheck(html)   // null when it played cleanly

const vm = require('vm');
const { validateHtml } = require('../mx2/validate');

function makeDom() {
  const listeners = []; // [target, type, fn]
  const byId = new Map();
  const all = [];

  const noop = () => {};
  // A 2D context: every method does nothing; measureText answers.
  const ctx2d = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });

  function element(tag = 'div', id = null) {
    const el = {
      tagName: String(tag).toUpperCase(), id, children: [], style: {}, dataset: {}, attributes: {},
      textContent: '', innerText: '', value: '', checked: false, disabled: false, hidden: false,
      width: 300, height: 150, offsetWidth: 300, offsetHeight: 150, clientWidth: 300, clientHeight: 150,
      className: '', parentNode: null, src: '', href: '', type: '', name: '',
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, force) { const on = force === undefined ? !this._s.has(c) : force; if (on) this._s.add(c); else this._s.delete(c); return on; },
        contains(c) { return this._s.has(c); }, replace(a, b) { this._s.delete(a); this._s.add(b); },
      },
      addEventListener(type, fn) { listeners.push([el, type, fn]); },
      removeEventListener(type, fn) { const i = listeners.findIndex((l) => l[0] === el && l[1] === type && l[2] === fn); if (i >= 0) listeners.splice(i, 1); },
      appendChild(c) { el.children.push(c); c.parentNode = el; all.push(c); return c; },
      append(...cs) { cs.forEach((c) => { if (typeof c === 'object') el.appendChild(c); }); },
      prepend(c) { if (typeof c === 'object') { el.children.unshift(c); c.parentNode = el; } },
      removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      replaceChildren(...cs) { detach(el); cs.forEach((c) => el.appendChild(c)); },
      insertBefore(c) { return el.appendChild(c); },
      setAttribute(k, v) { el.attributes[k] = String(v); }, getAttribute(k) { return el.attributes[k] ?? null; },
      removeAttribute(k) { delete el.attributes[k]; }, hasAttribute(k) { return k in el.attributes; },
      querySelector: () => element(), querySelectorAll: () => [element(), element(), element()],
      getContext: () => ctx2d(),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150, x: 0, y: 0 }),
      focus: noop, blur: noop, click() { fire(el, 'click'); }, reset: noop, submit: noop, select: noop,
      closest: () => el, contains: () => true, cloneNode: () => element(tag), scrollIntoView: noop,
      animate: () => ({ onfinish: null, cancel: noop }),
    };
    // Clearing an element (innerHTML = '' or new text) drops its children
    // and their listeners, like a real page.
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => html,
      set: (v) => { html = String(v); detach(el); },
    });
    all.push(el);
    return el;
  }

  function detach(el) {
    const gone = new Set();
    const walk = (e) => { for (const c of e.children || []) { gone.add(c); walk(c); } };
    walk(el);
    el.children = [];
    if (!gone.size) return;
    for (let i = listeners.length - 1; i >= 0; i--) if (gone.has(listeners[i][0])) listeners.splice(i, 1);
  }

  const body = element('body');
  const documentElement = element('html');
  const document = {
    body, documentElement, head: element('head'), title: '',
    getElementById(id) { if (!byId.has(id)) byId.set(id, element('div', id)); return byId.get(id); },
    querySelector(sel) { const m = /^#([\w-]+)$/.exec(sel); return m ? document.getElementById(m[1]) : element(); },
    querySelectorAll: () => { const list = [element(), element(), element(), element(), element(), element(), element(), element(), element()]; return list; },
    getElementsByClassName: () => [element(), element(), element()],
    getElementsByTagName: () => [element(), element()],
    createElement: (t) => element(t),
    createTextNode: (s) => ({ textContent: s }),
    addEventListener(type, fn) { listeners.push([document, type, fn]); },
    removeEventListener: noop,
    hidden: false,
  };

  function fire(target, type, extra = {}) {
    for (const [t, ty, fn] of [...listeners]) {
      if (ty !== type || (target !== null && t !== target)) continue;
      const ev = {
        type, target: t === document || t === win ? body : t, currentTarget: t, key: '', code: '', clientX: 120, clientY: 80,
        offsetX: 120, offsetY: 80, pageX: 120, pageY: 80, button: 0, repeat: false, touches: [{ clientX: 120, clientY: 80 }],
        changedTouches: [{ clientX: 120, clientY: 80 }], preventDefault: noop, stopPropagation: noop, ...extra,
      };
      fn.call(t, ev);
    }
  }

  const timers = [];
  let frames = [];
  const storage = new Map();
  const win = {
    document, innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
    addEventListener(type, fn) { listeners.push([win, type, fn]); },
    removeEventListener: noop,
    setInterval: (fn, ms) => { timers.push({ fn, every: true }); return timers.length; },
    setTimeout: (fn, ms) => { timers.push({ fn, every: false }); return timers.length; },
    clearInterval: (i) => { if (timers[i - 1]) timers[i - 1].dead = true; },
    clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].dead = true; },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: noop,
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k), clear: () => storage.clear() },
    alert: noop, confirm: () => true, prompt: () => '5',
    performance: { now: () => Date.now() },
    console: { log: noop, warn: noop, error: noop, info: noop },
    Audio: function Audio() { return { play: () => Promise.resolve(), pause: noop }; },
    AudioContext: function AudioContext() {
      const node = () => ({ connect: noop, start: noop, stop: noop, frequency: { value: 0, setValueAtTime: noop }, gain: { value: 0, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop }, type: '' });
      return { createOscillator: node, createGain: node, destination: {}, currentTime: 0 };
    },
    Image: function Image() { return element('img'); },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    Math, Date, JSON, Number, String, Array, Object, Promise, Map, Set, parseInt, parseFloat, isNaN, Symbol, Error, RegExp, Boolean, Infinity, NaN,
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;

  function runTimers(n) {
    for (let i = 0; i < n; i++) {
      for (const t of timers.slice()) {
        if (t.dead) continue;
        if (!t.every) t.dead = true;
        t.fn();
      }
      const f = frames;
      frames = [];
      for (const fn of f) fn(i * 16.7);
    }
  }

  return { win, document, fire, runTimers, all, listeners };
}

const KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'w', 'a', 's', 'd', 'r', 'p', 'Escape'];

function playCheck(html, { frames = 300 } = {}) {
  const problem = validateHtml(html);
  if (problem) return problem;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) return null;
  const dom = makeDom();
  const ctx = vm.createContext(dom.win);
  try {
    for (const s of scripts) vm.runInContext(s, ctx, { timeout: 2000 });
    dom.fire(null, 'DOMContentLoaded');
    dom.fire(null, 'load');
    dom.runTimers(frames);
    // Play: hold each key for a moment; click everything listening (newest
    // first, so buttons made by the game are pressed before "New game"
    // rebuilds them); then hold Space and arrows while tapping Space in a
    // rhythm that keeps a flapping game in the air.
    const key = (k, type) => dom.fire(null, type, { key: k, code: k === ' ' ? 'Space' : k.length === 1 ? `Key${k.toUpperCase()}` : k, repeat: false });
    for (let round = 0; round < 4; round++) {
      for (const k of KEYS) {
        key(k, 'keydown');
        dom.runTimers(10);
        key(k, 'keyup');
      }
      for (const type of ['click', 'mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchend', 'pointerdown', 'submit', 'input', 'change']) {
        for (let i = 0; i < 40; i++) {
          const targets = [...new Set(dom.listeners.filter((l) => l[1] === type).map((l) => l[0]))];
          if (!targets.length) break;
          if (round % 2 === 0) targets.reverse();
          dom.fire(targets[i % targets.length], type);
          dom.runTimers(2);
        }
      }
      key(' ', 'keydown');
      for (let f = 0; f < 400; f += 33) {
        const side = (f / 33) % 4 < 2 ? 'ArrowLeft' : 'ArrowRight';
        key(side, 'keydown');
        dom.runTimers(33);
        key(side, 'keyup');
        key(' ', 'keydown');
      }
      key(' ', 'keyup');
      dom.runTimers(frames / 2);
    }
  } catch (e) {
    return `runtime error: ${String(e && e.message ? e.message : e).slice(0, 200)}`;
  }
  return null;
}

module.exports = { playCheck };
