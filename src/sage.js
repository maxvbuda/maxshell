'use strict';

// Sage — maxshell's AI, Google's Gemma 4 running on this Mac — as a
// full-screen app. `sage` chats; `sage code` is a coding agent that reads,
// writes and edits files in the folder it's started in, showing every change
// as a diff and asking first (src/sagetools.js).
//
// The engine is src/gemma.py --serve, a separate process: commands go to it
// by appending JSON lines to a file, and its events (text as it's written,
// tool calls, done) come back the same way, so this stays synchronous like
// maxshell's other full-screen tools — keys are polled with KeyReader and the
// event file is read between them. The model is switched from a dropdown in
// the header (click it, or ^O).
//
// SageApp holds the state and logic; render() draws it. Neither needs a tty.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ansi = require('./ansi');
const theme = require('./theme');
const tui = require('./tui');
const { KeyReader } = require('./keys');
const { renderMarkdown } = require('./markdown');
const tools = require('./sagetools');

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MODEL_INFO = {
  e4b: { label: 'Sage Pro', blurb: 'smarter · ~9 GB' },
  e2b: { label: 'Sage Lite', blurb: 'twice as fast · ~5 GB' },
};

// --- the engine -----------------------------------------------------------------

class Engine {
  // argv runs the engine; it gets the command file appended to its args.
  constructor(argv, { cwd, env }) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-'));
    this.cmdFile = path.join(this.dir, 'commands');
    this.eventFile = path.join(this.dir, 'events');
    this.errFile = path.join(this.dir, 'errors');
    fs.writeFileSync(this.cmdFile, '');
    const out = fs.openSync(this.eventFile, 'w');
    const err = fs.openSync(this.errFile, 'w');
    // sh reports the engine's exit as a last event, and ignores SIGINT (it
    // only stops an answer); its own group gets it, not the terminal.
    const script = 'trap "" INT; "$@"; printf \'{"ev":"exit","code":%d}\\n\' $?';
    const args = [...argv.slice(1)];
    const at = args.indexOf('{commands}');
    if (at >= 0) args[at] = this.cmdFile; else args.push(this.cmdFile);
    this.child = spawn('/bin/sh', ['-c', script, 'sh', argv[0], ...args], {
      cwd, env: { ...env, MAXSHELL_SAGE_APP: String(process.pid) }, stdio: ['ignore', out, err], detached: true,
    });
    fs.closeSync(out);
    fs.closeSync(err);
    this.pos = 0;
    this.partial = '';
    this.closed = false;
  }

  send(cmd) {
    if (!this.closed) fs.appendFileSync(this.cmdFile, `${JSON.stringify(cmd)}\n`);
  }

  // New events since the last poll.
  poll() {
    let fd;
    try { fd = fs.openSync(this.eventFile, 'r'); } catch { return []; }
    const chunks = [];
    const buf = Buffer.alloc(65536);
    try {
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, this.pos);
        if (!n) break;
        this.pos += n;
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
    } finally { fs.closeSync(fd); }
    if (!chunks.length) return [];
    const text = this.partial + Buffer.concat(chunks).toString('utf8');
    const lines = text.split('\n');
    this.partial = lines.pop();
    const events = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* a stray print */ }
    }
    return events;
  }

  errors() {
    try { return fs.readFileSync(this.errFile, 'utf8'); } catch { return ''; }
  }

  interrupt() {
    try { process.kill(-this.child.pid, 'SIGINT'); } catch { /* gone */ }
  }

  close() {
    if (this.closed) return;
    this.send({ op: 'quit' });
    this.closed = true;
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* gone */ }
    try { this.child.unref(); } catch { /* fine */ }
    // Our own scratch files, not the user's.
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
}

// --- the app ------------------------------------------------------------------------

class SageApp {
  // models: [{ key, ready }]; start(key) returns an Engine-like object.
  constructor({ mode = 'chat', root = process.cwd(), model, models, start, ask = null, notice = null }) {
    this.mode = mode;
    this.root = root;
    this.models = models;
    this.start = start;
    this.items = [];
    this.input = '';
    this.cursor = 0;
    this.scroll = 0;
    this.menu = null;           // { index } while the model dropdown is open
    this.approval = null;       // the tool call waiting for a yes or no
    this.allowAll = false;      // "yes, don't ask again" to changes, for this session
    this.allowCommands = false; // …and to commands (risky ones are still asked)
    this.toRun = null;          // an approved command, run after the screen shows it
    this.pendingAsk = ask;      // sent once the model is ready
    this.notice = notice;       // why this model, shown on the welcome screen
    this.done = false;
    this.version = 0;           // bumped on every change, for redraws
    this.status = 'loading';
    this.history = [];
    this.historyAt = -1;
    this.useModel(model);
  }

  changed() { this.version++; }

  get busy() { return ['thinking', 'writing', 'waiting', 'running', 'stopping'].includes(this.status); }

  useModel(key) {
    this.model = key;
    this.status = 'loading';
    this.loadStarted = Date.now();
    this.engine = this.start(key, this.mode);
    this.changed();
  }

  note(text, tone = 'muted') {
    this.items.push({ type: 'note', text, tone });
    this.changed();
  }

  lastSage() {
    const last = this.items[this.items.length - 1];
    return last && last.type === 'sage' && !last.done ? last : null;
  }

  // --- engine events ---

  onEvent(ev) {
    switch (ev.ev) {
      case 'loading': this.status = 'loading'; break;
      case 'ready':
        this.status = 'ready';
        this.device = ev.device;
        if (this.pendingAsk) {
          const q = this.pendingAsk;
          this.pendingAsk = null;
          const waiting = this.items.find((i) => i.type === 'user' && i.queued);
          if (waiting) { waiting.queued = false; waiting.v = (waiting.v || 0) + 1; }
          this.send(q, !waiting);
        }
        break;
      case 'text': {
        let item = this.lastSage();
        if (!item) { item = { type: 'sage', text: '', done: false }; this.items.push(item); }
        item.text += ev.s;
        item.v = (item.v || 0) + 1;
        if (this.status !== 'stopping') this.status = 'writing';
        break;
      }
      case 'tool': this.onTool(ev.name, ev.args || {}); break;
      case 'done': {
        const item = this.lastSage();
        if (item) { item.done = true; item.v = (item.v || 0) + 1; }
        if (ev.stopped) this.note('stopped');
        if (ev.tokens && ev.seconds) this.speed = ev.tokens / ev.seconds;
        this.status = 'ready';
        break;
      }
      case 'error':
        this.status = 'error';
        this.note(ev.text, 'err');
        break;
      case 'exit':
        if (this.status !== 'error') {
          this.status = 'error';
          const tail = (this.engine.errors ? this.engine.errors() : '').trim().split('\n').slice(-3).join('\n');
          this.note(`Sage's engine stopped${tail ? `: ${tail}` : '.'}`, 'err');
        }
        break;
      default: return;
    }
    this.changed();
  }

  onTool(name, args) {
    const reply = (text) => this.engine.send({ op: 'result', text });
    if (this.mode !== 'code') { reply('There are no tools in chat. Suggest `sage code` for working with files.'); return; }
    const said = this.lastSage();
    if (said) said.done = true; // what Gemma said before the call
    const known = tools.READS.has(name) || tools.CHANGES.has(name) || tools.COMMANDS.has(name);
    if (!known) { reply(`There is no tool called ${name}.`); return; }
    if (tools.READS.has(name) && !tools.needsAsk(name, args, this.root)) {
      const r = tools.look(name, args, this.root);
      this.items.push({ type: 'tool', name, title: r.title, detail: r.detail, state: r.detail === 'failed' ? 'fail' : 'ok' });
      reply(r.text);
      return;
    }
    if (tools.COMMANDS.has(name)) {
      const command = String(args.command || '').trim();
      const item = { type: 'tool', name, title: `Run ${command}`, command, risky: tools.risky(command), state: 'ask' };
      this.items.push(item);
      if (!command) { item.state = 'fail'; item.detail = 'no command'; reply('No command was given.'); return; }
      if (this.allowCommands && !item.risky) { this.queueRun(item); return; }
      this.approval = { item, name, args };
      this.status = 'waiting';
      return;
    }
    if (tools.READS.has(name)) {
      const where = tools.pretty(tools.resolve(args.path, this.root), this.root);
      const item = { type: 'tool', name, title: `${name === 'list_files' ? 'List' : name === 'read_file' ? 'Read' : 'Search'} ${where}`, detail: 'outside the project folder', state: 'ask' };
      this.items.push(item);
      this.approval = { item, name, args };
      this.status = 'waiting';
      return;
    }
    const plan = tools.plan(name, args, this.root);
    const verb = name === 'write_file' ? (plan.before === null ? 'Create' : 'Write') : 'Edit';
    const where = plan.where || tools.pretty(tools.resolve(args.path, this.root), this.root);
    if (plan.error) {
      this.items.push({ type: 'tool', name, title: `${verb} ${where}`, detail: plan.error, state: 'fail' });
      reply(plan.error);
      return;
    }
    const d = tools.diff(plan.before, plan.after);
    const item = { type: 'tool', name, title: `${verb} ${where}`, detail: `+${d.added} −${d.removed}`, diff: d, state: 'ask' };
    this.items.push(item);
    if (this.allowAll) { this.finishChange(item, plan); return; }
    this.approval = { item, name, args, plan };
    this.status = 'waiting';
  }

  finishChange(item, plan) {
    const r = tools.apply(plan);
    item.state = r.ok ? 'ok' : 'fail';
    if (!r.ok) item.detail = r.text;
    item.v = (item.v || 0) + 1;
    this.engine.send({ op: 'result', text: r.text });
  }

  // Runs on the next tick, so "running" is on screen while it does.
  queueRun(item) {
    item.state = 'running';
    item.v = (item.v || 0) + 1;
    this.toRun = item;
    this.status = 'running';
    this.changed();
  }

  // Work that blocks: an approved command. The loop calls this after drawing.
  work() {
    const item = this.toRun;
    if (!item) return;
    this.toRun = null;
    const r = tools.runCommand({ command: item.command }, this.root);
    Object.assign(item, { state: r.ok ? 'ok' : 'fail', detail: r.detail, output: r.output });
    item.v = (item.v || 0) + 1;
    this.status = 'thinking';
    this.engine.send({ op: 'result', text: r.text });
    this.changed();
  }

  // y: yes; a: yes, and don't ask again this session; n: no.
  answer(choice) {
    const ap = this.approval;
    if (!ap) return;
    this.approval = null;
    this.status = 'thinking';
    if (choice === 'n') {
      ap.item.state = 'declined';
      ap.item.v = (ap.item.v || 0) + 1;
      this.engine.send({ op: 'result', text: 'The user said no to this. Ask them what they would like instead.' });
    } else if (ap.item.command) {
      if (choice === 'a' && !ap.item.risky) this.allowCommands = true; // a risky one is a single yes
      this.queueRun(ap.item);
    } else {
      if (choice === 'a') this.allowAll = true;
      if (ap.plan) this.finishChange(ap.item, ap.plan);
      else {
        const r = tools.look(ap.name, ap.args, this.root);
        Object.assign(ap.item, { detail: r.detail, state: r.detail === 'failed' ? 'fail' : 'ok' });
        this.engine.send({ op: 'result', text: r.text });
      }
    }
    this.changed();
  }

  // --- user actions ---

  send(text, show = true) {
    if (show) this.items.push({ type: 'user', text });
    this.engine.send({ op: 'ask', text });
    this.status = 'thinking';
    this.scroll = 0;
    this.changed();
  }

  submit() {
    const text = this.input.trim();
    if (!text) return;
    if (text.startsWith('/') && this.command(text)) { this.setInput(''); return; }
    if (this.status === 'loading') { this.pendingAsk = text; this.items.push({ type: 'user', text, queued: true }); this.setInput(''); return; }
    if (this.busy) { this.note('Sage is still answering — ^C stops it.'); return; }
    if (this.status === 'error') { this.note('Sage isn’t running — pick a model above (^O) to start it again.', 'err'); return; }
    this.history.push(text);
    this.historyAt = -1;
    this.setInput('');
    this.send(text);
  }

  command(text) {
    const [cmd, arg] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case 'new': case 'clear': this.newChat(); return true;
      case 'model':
        if (arg && MODEL_INFO[arg.toLowerCase()]) this.switchModel(arg.toLowerCase()); else this.openMenu();
        return true;
      case 'exit': case 'quit': case 'bye': this.done = true; return true;
      case 'help':
        this.note(`/new  a fresh conversation  ·  /model [e4b|e2b]  switch models  ·  /exit  leave\n^O models · ^N new chat · PgUp/PgDn or the wheel scroll · ^C stops an answer (or leaves)${this.mode === 'code' ? ' · y / a / n answer a change' : ''}`);
        return true;
      default: return false;
    }
  }

  newChat() {
    if (this.busy) { this.note('Sage is still answering — ^C stops it.'); return; }
    this.items = [];
    this.allowAll = false;
    this.scroll = 0;
    if (this.status === 'ready') { this.engine.send({ op: 'reset' }); this.status = 'loading'; }
    this.changed();
  }

  switchModel(key) {
    this.menu = null;
    const m = this.models.find((x) => x.key === key);
    if (!m) return;
    if (key === this.model && this.status !== 'error') { this.changed(); return; }
    if (!m.ready) { this.note(`${MODEL_INFO[key].label} isn’t set up — run: sage --${key === 'e2b' ? 'lite' : 'pro'} --setup`, 'err'); return; }
    if (this.approval) this.answer('n');
    this.engine.close();
    if (this.items.length) this.note(`Switched to ${MODEL_INFO[key].label} — a fresh conversation.`);
    this.useModel(key);
  }

  openMenu() {
    this.menu = { index: Math.max(0, this.models.findIndex((m) => m.key === this.model)) };
    this.changed();
  }

  interrupt() {
    if (this.menu) { this.menu = null; this.changed(); return; }
    if (this.approval) this.answer('n');
    if (this.busy) {
      this.status = 'stopping';
      this.engine.interrupt();
      this.changed();
      return;
    }
    if (this.input) { this.setInput(''); return; }
    this.done = true;
  }

  setInput(text, cursor = text.length) {
    this.input = text;
    this.cursor = cursor;
    this.changed();
  }

  // --- keys ---

  key(k) {
    if (k.name === 'eof') { this.done = true; return; }
    if (k.name === 'mouse') return;
    if (k.ctrl && k.name === 'c') { this.interrupt(); return; }
    if (this.menu) { this.menuKey(k); return; }
    if (this.approval) {
      const c = (k.str || '').toLowerCase();
      if (c === 'y' || c === 'a' || c === 'n') { this.answer(c); return; }
      if (k.name === 'escape') { this.answer('n'); return; }
      if (k.name === 'return') { this.answer('y'); return; }
    }
    if (k.ctrl && k.name === 'o') { this.openMenu(); return; }
    if (k.ctrl && k.name === 'n') { this.newChat(); return; }
    if (k.ctrl && k.name === 'd' && !this.input) { this.done = true; return; }
    if (k.name === 'pageup') { this.scroll += 10; this.changed(); return; }
    if (k.name === 'pagedown') { this.scroll = Math.max(0, this.scroll - 10); this.changed(); return; }
    if (this.approval) return;
    this.editKey(k);
  }

  menuKey(k) {
    const n = this.models.length;
    if (k.name === 'up') this.menu.index = (this.menu.index + n - 1) % n;
    else if (k.name === 'down' || k.name === 'tab') this.menu.index = (this.menu.index + 1) % n;
    else if (k.name === 'return') { this.switchModel(this.models[this.menu.index].key); return; }
    else if (k.name === 'escape' || (k.ctrl && k.name === 'o')) this.menu = null;
    this.changed();
  }

  editKey(k) {
    const s = this.input;
    const c = this.cursor;
    if (k.name === 'return' && k.meta) { this.setInput(s.slice(0, c) + '\n' + s.slice(c), c + 1); return; }
    if (k.name === 'return') { this.submit(); return; }
    if (k.name === 'backspace') { if (c) this.setInput(s.slice(0, c - 1) + s.slice(c), c - 1); return; }
    if (k.name === 'delete') { this.setInput(s.slice(0, c) + s.slice(c + 1), c); return; }
    if (k.name === 'left') { this.cursor = Math.max(0, c - 1); this.changed(); return; }
    if (k.name === 'right') { this.cursor = Math.min(s.length, c + 1); this.changed(); return; }
    if (k.name === 'home' || (k.ctrl && k.name === 'a')) { this.cursor = 0; this.changed(); return; }
    if (k.name === 'end' || (k.ctrl && k.name === 'e')) { this.cursor = s.length; this.changed(); return; }
    if (k.ctrl && k.name === 'u') { this.setInput(s.slice(c), 0); return; }
    if (k.ctrl && k.name === 'k') { this.setInput(s.slice(0, c), c); return; }
    if (k.ctrl && k.name === 'w') {
      const before = s.slice(0, c).replace(/\S+\s*$/, '');
      this.setInput(before + s.slice(c), before.length);
      return;
    }
    if (k.name === 'up' || k.name === 'down') {
      if (!this.history.length) return;
      if (k.name === 'up') this.historyAt = this.historyAt < 0 ? this.history.length - 1 : Math.max(0, this.historyAt - 1);
      else this.historyAt = this.historyAt < 0 ? -1 : this.historyAt + 1;
      if (this.historyAt >= this.history.length) this.historyAt = -1;
      this.setInput(this.historyAt < 0 ? '' : this.history[this.historyAt]);
      return;
    }
    if (k.printable) this.setInput(s.slice(0, c) + k.str + s.slice(c), c + k.str.length);
  }

  // A click or the wheel, given what's at that spot on the screen.
  mouse(k, hit) {
    if (k.button === 64) { this.scroll += 3; this.changed(); return; }
    if (k.button === 65) { this.scroll = Math.max(0, this.scroll - 3); this.changed(); return; }
    if (k.release || k.button !== 0) return;
    if (hit && hit.action === 'menu') { if (this.menu) { this.menu = null; this.changed(); } else this.openMenu(); return; }
    if (hit && hit.action === 'model') { this.switchModel(hit.key); return; }
    if (hit && hit.action === 'answer') { this.answer(hit.choice); return; }
    if (hit && hit.action === 'try') { this.setInput(hit.text); return; }
    if (this.menu) { this.menu = null; this.changed(); }
  }

  close() {
    this.engine.close();
  }
}

// --- drawing -------------------------------------------------------------------

const RESET = () => ansi.reset();
const fitText = (s, w) => tui.fit(s, Math.max(0, w));
const hilite = (text) => `${theme.fg('accent')}${ansi.bold()}${text}${RESET()}`;

// Wraps plain text to width w (wide characters count as two).
function wrap(text, w) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    let lw = 0;
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const ww = tui.textWidth(word);
      if (lw + ww > w && line.trim()) {
        out.push(line.trimEnd());
        line = /^\s+$/.test(word) ? '' : word;
        lw = tui.textWidth(line);
      } else {
        line += word;
        lw += ww;
      }
      while (lw > w) { // a word longer than the line
        const chars = [...line];
        let cut = '';
        let cw = 0;
        while (chars.length && cw + tui.textWidth(chars[0]) <= w) { cw += tui.textWidth(chars[0]); cut += chars.shift(); }
        out.push(cut);
        line = chars.join('');
        lw = tui.textWidth(line);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

// The lines of one transcript item, each { s, hits? } at width w.
function itemLines(item, w, app) {
  const { ui } = theme.current();
  const muted = theme.fg('muted');
  const lines = [];
  if (item.type === 'user') {
    const body = wrap(item.text, w - 2);
    body.forEach((l, i) => lines.push({ s: `${i ? '  ' : `${theme.fg('accent2')}${ansi.bold()}❯${RESET()} `}${ansi.bold()}${l}${RESET()}${item.queued && i === body.length - 1 ? `${muted}  (sent once Sage is ready)${RESET()}` : ''}` }));
    return lines;
  }
  if (item.type === 'note') {
    const color = item.tone === 'err' ? theme.fg('err') : muted;
    for (const l of wrap(item.text, w - 2)) lines.push({ s: `  ${color}${l}${RESET()}` });
    return lines;
  }
  if (item.type === 'sage') {
    const text = item.text.replace(/^\s+/, '');
    const md = text ? renderMarkdown(text, { width: w - 2 }).split('\n') : [''];
    md.forEach((l, i) => lines.push({ s: `${i ? '  ' : `${hilite('✦')} `}${l}${RESET()}` }));
    if (!item.done && app && app.status === 'writing') lines[lines.length - 1].s += `${muted}▍${RESET()}`;
    return lines;
  }
  // a tool
  const dot = { ok: theme.fg('ok'), fail: theme.fg('err'), ask: theme.fg('warn'), running: theme.fg('accent'), declined: muted }[item.state] || muted;
  const detail = item.state === 'declined' ? 'declined' : item.state === 'running' ? 'running…' : item.detail;
  if (item.command !== undefined) {
    // a command: $ line(s), then what it printed
    lines.push({ s: `${dot}●${RESET()} ${ansi.bold()}Run${RESET()}${detail ? `${muted} · ${detail}${RESET()}` : ''}${item.risky && item.state === 'ask' ? `  ${theme.fg('warn')}careful: this can delete or overwrite things${RESET()}` : ''}` });
    wrap(item.command, w - 4).slice(0, 8).forEach((l, i) => lines.push({ s: `  ${muted}${i ? ' ' : '$'}${RESET()} ${theme.style(theme.current().syntax.code)}${l}${RESET()}` }));
    if (item.output) {
      const out = item.output.split('\n');
      const shown = out.length > 8 ? [...out.slice(0, 3), `… ${out.length - 6} more lines …`, ...out.slice(-3)] : out;
      for (const l of shown) lines.push({ s: `    ${muted}${fitText(l.replace(/\t/g, '    '), w - 4).trimEnd()}${RESET()}` });
    }
  }
  const head = `${dot}●${RESET()} ${ansi.bold()}${item.title}${RESET()}${detail ? `${muted} · ${detail}${RESET()}` : ''}`;
  if (item.command !== undefined) { /* drawn above */ } else if (tui.textWidth(ansi.strip(head)) <= w) lines.push({ s: head });
  else lines.push({ s: `${dot}●${RESET()} ${fitText(`${item.title}${detail ? ` · ${detail}` : ''}`, w - 2)}` });
  if (item.diff && (item.state === 'ask' || item.state === 'ok')) {
    const rows = item.diff.rows;
    const shown = item.state === 'ask' ? rows.slice(0, 40) : rows.slice(0, 12);
    const numW = Math.max(2, String(Math.max(0, ...rows.map((r) => r.b || r.a || 0))).length);
    for (const r of shown) {
      if (r.kind === '…') { lines.push({ s: `  ${muted}${' '.repeat(numW)} ⋯${RESET()}` }); continue; }
      const color = r.kind === '+' ? theme.fg('ok') : r.kind === '-' ? theme.fg('err') : muted;
      const num = String(r.kind === '-' ? r.a : r.b).padStart(numW);
      const text = r.text.replace(/\t/g, '    ');
      lines.push({ s: `  ${muted}${num}${RESET()} ${color}${r.kind === ' ' ? ' ' : r.kind} ${fitText(text, w - numW - 6).trimEnd()}${RESET()}` });
    }
    if (rows.length > shown.length) lines.push({ s: `  ${muted}… ${rows.length - shown.length} more lines of changes${RESET()}` });
  }
  if (item.state === 'ask' && app && app.approval && app.approval.item === item) {
    const q = item.diff ? 'Make this change?' : item.command !== undefined ? 'Run it?' : 'Allow it?';
    const again = item.diff ? 'Yes, and don’t ask again' : item.command !== undefined ? 'Yes, and don’t ask for commands' : 'Yes to all';
    const buttons = [['y', 'Yes'], ...(item.risky ? [] : [['a', again]]), ['n', 'No']];
    let s = `  ${theme.fg('warn')}${q}${RESET()} `;
    let x = 2 + tui.textWidth(q) + 1;
    const hits = [];
    for (const [choice, label] of buttons) {
      const text = ` ${choice} ${label} `;
      const tw = tui.textWidth(text);
      if (x + tw + 1 > w) break;
      s += ` ${theme.bg(ui.select.bg)}${ansi.fg(ui.select.fg)}${text}${RESET()}`;
      hits.push({ x0: x + 1, x1: x + 1 + tw, action: 'answer', choice });
      x += tw + 1;
    }
    lines.push({ s, hits });
  }
  return lines;
}

const tildify = (p) => (p === os.homedir() ? '~' : p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

function welcome(app, w) {
  const muted = theme.fg('muted');
  const center = (plain, styled = plain) => {
    const pad = Math.max(0, Math.floor((w - tui.textWidth(plain)) / 2));
    return { s: ' '.repeat(pad) + styled };
  };
  const out = [{ s: '' }, { s: '' }];
  const logo = w >= 30 ? '✦  S  A  G  E' : '✦ SAGE';
  out.push(center(logo, `${ansi.bold()}${theme.gradientText(logo)}${RESET()}`));
  out.push({ s: '' });
  const lines = app.mode === 'code'
    ? ['Sage Code: your AI pair programmer, on your Mac.', `It reads, writes and edits files and runs commands in ${tildify(app.root)}.`,
      'Every change and command is shown and asked first;', 'replaced files go to the Trash, never lost.']
    : ['An AI that runs entirely on your Mac.', 'Private · offline · no account · no API key.'];
  for (const l of lines) for (const part of wrap(l, w)) out.push(center(part, `${part}`));
  out.push({ s: '' });
  const tries = app.mode === 'code'
    ? ['add a --verbose flag to main.py', 'why does test_parser fail? fix it', 'write a README for this project']
    : ['explain what a closure is, with an example', 'solve x² − 5x + 6 = 0 step by step', 'write a haiku about the terminal'];
  if (app.notice) {
    for (const part of wrap(app.notice, w)) out.push(center(part, `${theme.fg('warn')}${part}${RESET()}`));
    out.push({ s: '' });
  }
  out.push(center('try', `${muted}try${RESET()}`));
  for (const t of tries) { // click one to start with it
    const plain = fitText(`“${t}”`, w).trimEnd();
    const line = center(plain, `${theme.fg('accent')}${plain}${RESET()}`);
    const x0 = line.s.length - line.s.trimStart().length;
    line.hits = [{ x0, x1: x0 + tui.textWidth(plain), action: 'try', text: t }];
    out.push(line);
  }
  return out;
}

// The screen at cols × rows: { lines, cursor: {x, y} | null, hits: [{y, x0, x1, …}] }.
function render(app, cols, rows, now = Date.now()) {
  const { ui } = theme.current();
  const muted = theme.fg('muted');
  const hits = [];
  const W = Math.max(10, cols);

  // header: brand, mode, folder · status, model dropdown
  const barBg = theme.bg(ui.bar.bg);
  const barFg = ansi.fg(ui.bar.fg);
  const info = MODEL_INFO[app.model] || { label: app.model };
  const drop = ` ◆ ${info.label} ${app.menu ? '▴' : '▾'} `;
  const spin = SPIN[Math.floor(now / 90) % SPIN.length];
  const status = {
    loading: `${spin} waking ${info.label}…`, ready: app.speed ? `ready · ${app.speed.toFixed(1)} tok/s` : 'ready',
    thinking: `${spin} thinking`, writing: `${spin} writing`, waiting: 'waiting for you', running: `${spin} running a command`, stopping: `${spin} stopping`, error: 'not running',
  }[app.status] || app.status;
  const brand = ' ✦ Sage';
  const pill = app.mode === 'code' ? ' code ' : ' chat ';
  const left = `${brand} ${pill}`;
  const dropW = tui.textWidth(drop);
  const room = W - tui.textWidth(left) - dropW;
  const full = ` ${status} `;
  const statusText = room < 5 ? '' : tui.textWidth(full) <= room ? full : fitText(full, room);
  const gap = Math.max(0, W - tui.textWidth(left) - tui.textWidth(statusText) - dropW);
  let header;
  if (W >= tui.textWidth(left) + dropW) {
    header = `${barBg}${barFg}${ansi.bold()}${brand}${RESET()}${barBg} ${theme.bg(ui.select.bg)}${ansi.fg(ui.select.fg)}${pill}${RESET()}${barBg}${barFg}${' '.repeat(gap)}${statusText}${theme.bg(ui.select.bg)}${ansi.fg(ui.select.fg)}${ansi.bold()}${drop}${RESET()}`;
    hits.push({ y: 0, x0: W - dropW, x1: W, action: 'menu' });
  } else {
    header = tui.bar(` ✦ Sage · ${info.label} ▾`, W);
    hits.push({ y: 0, x0: 0, x1: W, action: 'menu' });
  }

  // input box
  const inner = Math.max(4, W - 6);
  const prompt = app.approval ? 'answer above: y / a / n' : app.mode === 'code' ? 'Tell Sage what to build or fix…' : 'Ask Sage anything…';
  const inputRows = [];
  let cursor = null;
  {
    // wrap the input by characters, tracking the cursor
    const chars = [...app.input];
    let line = '';
    let lw = 0;
    let cur = null;
    const flush = () => { inputRows.push(line); line = ''; lw = 0; };
    for (let i = 0; i <= chars.length; i++) {
      if (i === app.cursor) cur = { row: inputRows.length, col: lw };
      if (i === chars.length) break;
      const ch = chars[i];
      if (ch === '\n') { flush(); continue; }
      const cw = tui.textWidth(ch);
      if (lw + cw > inner) flush();
      line += ch;
      lw += cw;
    }
    flush();
    if (cur && cur.col >= inner) cur = { row: cur.row + 1, col: 0 };
    const maxRows = Math.max(1, Math.min(6, Math.floor(rows / 4)));
    const first = Math.max(0, (cur ? cur.row : 0) - maxRows + 1);
    const shown = inputRows.slice(first, first + maxRows);
    inputRows.length = 0;
    inputRows.push(...shown);
    if (cur) cursor = { row: cur.row - first, col: cur.col };
  }
  const frame = theme.fg(app.approval ? 'muted' : app.busy ? 'muted' : 'accent');
  const box = [];
  box.push(`${frame}╭${'─'.repeat(W - 2)}╮${RESET()}`);
  inputRows.forEach((l, i) => {
    const content = !app.input && i === 0 ? `${muted}${fitText(prompt, inner)}${RESET()}` : fitText(l, inner);
    box.push(`${frame}│${RESET()} ${i === 0 ? `${theme.fg('accent2')}${ansi.bold()}❯${RESET()}` : ' '} ${content} ${frame}│${RESET()}`);
  });
  box.push(`${frame}╰${'─'.repeat(W - 2)}╯${RESET()}`);
  const keysHelp = app.approval ? `y yes${app.approval.item.risky ? '' : ' · a yes to all'} · n no (Esc) · ^C stop`
    : app.busy ? '^C stop · PgUp/PgDn scroll'
      : 'enter send · ⌥enter new line · ^O model · ^N new chat · /help · ^C quit';
  const footer = `${muted}${fitText(` ${keysHelp}`, W).trimEnd()}${RESET()}`;

  // transcript
  const bodyH = Math.max(1, rows - 1 - box.length - 1);
  const w = Math.max(8, W - 4);
  let body = [];
  if (!app.items.length) body = welcome(app, w);
  for (const item of app.items) {
    if (item.type === 'sage' && !item.text.trim()) continue; // only whitespace between tool calls
    body.push({ s: '' }); // a blank line above each item, the first too
    const key = `${w}:${item.v || 0}:${item.state || ''}:${app.approval && app.approval.item === item}:${item.type === 'sage' && !item.done ? app.status : ''}`;
    if (!item.cache || item.cacheKey !== key) { item.cache = itemLines(item, w, app); item.cacheKey = key; }
    body.push(...item.cache);
  }
  const writing = app.lastSage();
  if ((app.status === 'thinking' || app.status === 'stopping') && !(writing && writing.text.trim())) {
    body.push({ s: '' }, { s: `${hilite('✦')} ${muted}${SPIN[Math.floor(now / 90) % SPIN.length]} ${app.status === 'stopping' ? 'stopping' : 'thinking'}…${RESET()}` });
  }
  const maxScroll = Math.max(0, body.length - bodyH);
  if (app.scroll > maxScroll) app.scroll = maxScroll;
  const start = Math.max(0, body.length - bodyH - app.scroll);
  const visible = body.slice(start, start + bodyH);

  const lines = [header];
  visible.forEach((l, i) => {
    lines.push(`  ${l.s}`);
    for (const h of l.hits || []) hits.push({ ...h, y: 1 + i, x0: h.x0 + 2, x1: h.x1 + 2 });
  });
  while (lines.length < 1 + bodyH) lines.push('');
  if (app.scroll > 0) {
    const more = `${muted}↓ ${app.scroll} more line${app.scroll === 1 ? '' : 's'} below · PgDn${RESET()}`;
    lines[lines.length - 1] = ' '.repeat(Math.max(0, W - tui.textWidth(ansi.strip(more)) - 1)) + more;
  }

  // the dropdown, over the transcript at the right
  if (app.menu) {
    const entries = app.models.map((m) => {
      const mi = MODEL_INFO[m.key] || { label: m.key, blurb: '' };
      return { m, text: ` ${m.key === app.model ? '✓' : ' '} ${mi.label}  `, blurb: m.ready ? `${mi.blurb} ` : 'not set up ' };
    });
    const mw = Math.min(W - 2, Math.max(...entries.map((e) => tui.textWidth(e.text) + tui.textWidth(e.blurb))) + 2);
    const x0 = Math.max(0, W - mw - 1);
    const put = (y, s) => { if (y < lines.length) lines[y] = `${' '.repeat(x0)}${s}`; };
    put(1, `${theme.fg('accent')}╭${'─'.repeat(mw - 2)}╮${RESET()}`);
    entries.forEach((e, i) => {
      const sel = i === app.menu.index;
      const bg = sel ? `${theme.bg(ui.select.bg)}${ansi.fg(ui.select.fg)}` : '';
      // the label first; the blurb gets what room is left
      const room = mw - 2;
      const labelW = Math.min(tui.textWidth(e.text), room);
      const blurbText = fitText(e.blurb, room - labelW);
      const label = fitText(e.text, room - tui.textWidth(blurbText));
      const blurb = sel ? blurbText : `${muted}${blurbText}${RESET()}`;
      put(2 + i, `${theme.fg('accent')}│${RESET()}${bg}${ansi.bold()}${label}${RESET()}${bg}${blurb}${RESET()}${theme.fg('accent')}│${RESET()}`);
      hits.push({ y: 2 + i, x0, x1: x0 + mw, action: 'model', key: e.m.key });
    });
    const tip = fitText(' ↑↓ enter · esc ', mw - 2);
    put(2 + entries.length, `${theme.fg('accent')}╰${RESET()}${muted}${tip}${RESET()}${theme.fg('accent')}╯${RESET()}`);
  }

  const boxTop = lines.length;
  lines.push(...box, footer);
  if (cursor && !app.approval && !app.menu) cursor = { x: 4 + cursor.col, y: boxTop + 1 + cursor.row };
  else cursor = null;
  return { lines: lines.slice(0, rows), cursor, hits };
}

// --- running it -----------------------------------------------------------------

function loop(app, { input = 0, output = process.stdout } = {}) {
  const reader = new KeyReader(input);
  let drawn = '';
  let last = null;
  let lastSpin = 0;
  const draw = (force) => {
    const now = Date.now();
    const spinning = app.status !== 'ready' && app.status !== 'error' && app.status !== 'waiting';
    const key = `${app.version}:${output.columns}x${output.rows}`;
    if (!force && key === drawn && !(spinning && now - lastSpin > 90)) return;
    lastSpin = now;
    drawn = key;
    last = render(app, output.columns || 80, output.rows || 24, now);
    let s = '\x1b[?25l\x1b[H';
    s += last.lines.map((l) => `${l}${RESET()}\x1b[K`).join('\r\n');
    if (last.lines.length < (output.rows || 24)) s += '\x1b[J';
    if (last.cursor) s += `\x1b[${last.cursor.y + 1};${last.cursor.x + 1}H\x1b[?25h`;
    output.write(s);
  };
  draw(true);
  while (!app.done) {
    const k = reader.next(40);
    if (k.name === 'mouse') {
      const hit = last && last.hits.find((h) => h.y === k.y - 1 && k.x - 1 >= h.x0 && k.x - 1 < h.x1);
      app.mouse(k, hit);
    } else if (k.name !== 'timeout') {
      app.key(k);
    }
    for (const ev of app.engine.poll()) app.onEvent(ev);
    if (!app.done) draw(false);
    if (app.toRun) { app.work(); draw(true); }
  }
  app.close();
  return 0;
}

module.exports = { Engine, SageApp, render, wrap, itemLines, loop, MODEL_INFO };
