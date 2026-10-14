'use strict';

// Sage — maxshell's AI, Google's Gemma 4 running on this Mac — as a
// full-screen app. `sage` chats; `sage code` is a coding agent that reads,
// writes and edits files in the folder it's started in, showing every change
// as a diff and asking first (src/sagetools.js).
//
// The engine is src/sage.py --serve, a separate process: commands go to it
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
const conversations = require('./conversations');

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MODEL_INFO = {
  ultra: { label: 'Sage Ultra', blurb: 'smartest · ~16 GB', flag: 'ultra', thinks: true },
  e4b: { label: 'Sage Pro', blurb: 'smart all-rounder · ~5 GB', flag: 'pro', thinks: true, when: true },
  e2b: { label: 'Sage Flash', blurb: 'fast · ~3 GB', flag: 'flash', thinks: true, when: true },
  lite: { label: 'Sage Lite', blurb: 'fastest · ~3 GB', flag: 'lite' }, // sage code's
};
// In a chat, Sage Lite is a different, smaller model than in sage code.
const CHAT_INFO = { lite: { label: 'Sage Lite', blurb: 'fastest · ~1 GB', flag: 'lite' } };
const modelInfo = (mode, key) => (mode !== 'code' && CHAT_INFO[key]) || MODEL_INFO[key];
// How much Sage thinks before answering (^T, the header, /think). Sage Pro
// and Flash ("when") think only when a question needs it, below high.
const THINKING = ['off', 'low', 'medium', 'high'];
const THINK_INFO = { off: 'answers straight away', low: 'a quick think first', medium: 'thinks it through', high: 'thinks longest, for the hardest questions' };
const WHEN_INFO = { off: 'answers straight away', low: 'thinks when a question needs it — sums, puzzles, code', medium: 'thinks when a question needs it — sums, puzzles, code', high: 'always thinks first' };
const firstThinking = () => { const v = { xhigh: 'high' }[process.env.MAXSHELL_SAGE_EFFORT] || process.env.MAXSHELL_SAGE_EFFORT; return THINKING.includes(v) ? v : 'medium'; };

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

// No model to talk to: image chat only draws.
const IDLE = { send() {}, poll: () => [], close() {}, interrupt() {}, errors: () => '' };

// --- the app ------------------------------------------------------------------------

class SageApp {
  // models: [{ key, ready }]; start(key) returns an Engine-like object.
  constructor({ mode = 'chat', root = process.cwd(), model, models, start, ask = null, notice = null, startImage = null, startVideo = null, resume = null }) {
    this.id = conversations.newId(); // where this conversation is kept (src/conversations.js)
    this.startImage = startImage; // (options) → a sageimage Job, or null when it isn't set up
    this.startVideo = startVideo; // video chat: (options) → a sagevideo job
    this.clip = null;             // video chat: the latest clip, which the next message changes or extends
    this.clipName = null;         // …and the first prompt, which names every version
    this.clipOpts = { seconds: 2, sound: true };
    this.posters = null;          // a scratch folder for clips' preview frames
    this.picture = null;          // image chat: the latest version, which the next message edits
    this.pictureName = null;      // …and the first prompt, which names every version
    this.fitted = null;           // a picture of yours: its shape, which edits keep
    this.scene = null;            // what the picture shows (Sage's prompt for it), and…
    this.changes = [];            // …the changes asked for since: what Sage writes edits from
    this.exact = false;           // /exact: draw from the words as they are, not Sage's prompt
    this.drawOpts = { width: 768, height: 768, steps: 8 };
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
    this.thinking = firstThinking();
    this.suggestion = null;     // Sage's guess at your next message, shown in the empty box
    this.useModel(model);
    if (resume) this.resume(resume);
  }

  // Picks up an earlier conversation ({ id, items }): it's shown, and the
  // model is told all of it, so Sage remembers.
  resume(conv) {
    this.id = conv.id;
    this.suggestion = null;
    this.items = conversations.plain(conv.items || []);
    const last = (type) => [...this.items].reverse().find((i) => i.type === type && i.state === 'done' && i.out && fs.existsSync(i.out));
    if (this.mode === 'image' && last('image')) {
      const p = last('image');
      this.picture = p.out;
      this.pictureName = (this.items.find((i) => i.type === 'user') || {}).text || 'picture';
      this.scene = p.detailed || p.prompt || null;
      this.changes = [];
    }
    if (this.mode === 'video' && last('video')) {
      const v = last('video');
      this.clip = v.out;
      this.clipName = (this.items.find((i) => i.type === 'user') || {}).text || 'clip';
      this.scene = v.detailed || v.prompt || null;
      this.changes = [];
    }
    this.remember();
    this.scroll = 0;
    this.changed();
  }

  // Tells a (new) engine the conversation so far.
  remember() {
    if (this.media || !this.items.some((i) => i.type === 'user')) return;
    this.engine.send({ op: 'restore', turns: conversations.turns(this.items) });
  }

  changed() { this.version++; }

  // Image or video chat: no language model, the conversation makes media.
  get media() { return this.mode === 'image' || this.mode === 'video'; }

  // Whether this model thinks first, so the thinking level applies.
  get thinks() { return !this.media && !!(modelInfo(this.mode, this.model) || {}).thinks; }

  setThinking(level, say = false) {
    if (!THINKING.includes(level)) { this.note(`Thinking can be ${THINKING.join(', ')}.`, 'err'); return; }
    this.thinking = level;
    if (this.thinks) this.engine.send({ op: 'think', level });
    if (say) this.note(`Thinking: ${level} — ${this.thinkInfo(level)}${this.thinks ? '.' : '. Sage Lite doesn’t think; it applies to the others.'}`);
    this.changed();
  }

  thinkInfo(level) { return ((modelInfo(this.mode, this.model) || {}).when ? WHEN_INFO : THINK_INFO)[level]; }

  cycleThinking() {
    if (!this.thinks) { this.note('Sage Lite doesn’t think before it answers — pick another model with ^O.'); return; }
    this.setThinking(THINKING[(THINKING.indexOf(this.thinking) + 1) % THINKING.length]);
  }

  get busy() { return ['thinking', 'writing', 'waiting', 'running', 'stopping'].includes(this.status); }

  // Lets the model go while nobody is using it (it holds GBs — Ultra 16):
  // the loop calls this after IDLE_MS without a key or an answer. The next
  // message starts it again and tells it the conversation.
  rest() {
    if (this.media || this.resting || this.busy || this.approval || this.status !== 'ready') return false;
    this.engine.close();
    this.resting = true;
    return true;
  }

  wake() {
    if (!this.resting) return;
    this.resting = false;
    this.useModel(this.model);
    this.remember();
  }

  useModel(key) {
    this.model = key;
    if (this.media) { this.engine = IDLE; this.status = 'ready'; this.changed(); return; }
    this.status = 'loading';
    this.loadStarted = Date.now();
    this.engine = this.start(key, this.mode);
    if (this.thinks) this.engine.send({ op: 'think', level: this.thinking });
    this.changed();
  }

  note(text, tone = 'muted') {
    this.items.push({ type: 'note', text, tone });
    this.changed();
  }

  // Ends the thinking being shown, if any, with how long it took.
  endThought() {
    const last = this.items[this.items.length - 1];
    if (!last || last.type !== 'thought' || last.done) return;
    last.done = true;
    last.seconds = Math.max(1, Math.round((Date.now() - last.started) / 1000));
    last.v = (last.v || 0) + 1;
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
      case 'think': {
        let item = this.items[this.items.length - 1];
        if (!item || item.type !== 'thought' || item.done) { item = { type: 'thought', text: '', done: false, started: Date.now() }; this.items.push(item); }
        item.text += ev.s;
        item.v = (item.v || 0) + 1;
        break;
      }
      case 'text': {
        this.endThought();
        let item = this.lastSage();
        if (!item) { item = { type: 'sage', text: '', done: false }; this.items.push(item); }
        item.text += ev.s;
        item.v = (item.v || 0) + 1;
        if (this.status !== 'stopping') this.status = 'writing';
        break;
      }
      case 'tool': this.endThought(); this.onTool(ev.name, ev.args || {}); break;
      case 'suggest': // what you might say next: shown in the empty box, Tab takes it
        if (this.status === 'ready' && !this.input && this.items.length && this.items[this.items.length - 1].type !== 'user') this.suggestion = String(ev.text || '');
        break;
      case 'image-prompt': this.onImagePrompt(ev); break;
      case 'done': {
        this.endThought();
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
    this.suggestion = null;
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
    if (this.mode === 'video') {
      if (this.drawing()) { this.note('Still filming — ^C stops it.'); return; }
      this.history.push(text);
      this.historyAt = -1;
      this.setInput('');
      this.items.push({ type: 'user', text });
      this.film(text);
      return;
    }
    if (this.mode === 'image') {
      if (this.drawing()) { this.note('Still drawing — ^C stops it.'); return; }
      const dropped = require('./sageimage').droppedPath(text, this.root); // a file dragged in
      if (dropped) { this.setInput(''); this.load(dropped); return; }
      this.history.push(text);
      this.historyAt = -1;
      this.setInput('');
      this.items.push({ type: 'user', text });
      this.draw(text);
      return;
    }
    this.wake();
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
      case 'model': {
        const key = arg && ({ pro: 'e4b', flash: 'e2b' }[arg.toLowerCase()] || arg.toLowerCase());
        if (key && modelInfo(this.mode, key)) this.switchModel(key); else this.openMenu();
        return true;
      }
      case 'exit': case 'quit': case 'bye': this.done = true; return true;
      case 'image': case 'draw': this.image(text.slice(cmd.length + 1).trim()); return true;
      case 'size': case 'steps': {
        if (this.mode !== 'image') return false;
        const o = require('./sageimage').parseArgs([`--${cmd}`, arg || '', 'x']);
        if (o.error) { this.note(o.error, 'err'); return true; }
        Object.assign(this.drawOpts, cmd === 'size' ? { width: o.width, height: o.height } : { steps: o.steps });
        if (cmd === 'size' && this.fitted) { // your picture keeps its shape unless WxH says otherwise
          this.fitted = o.sized ? null : require('./sageimage').fitSize(this.fitted.width, this.fitted.height, o.width);
        }
        const now = this.fitted || this.drawOpts;
        this.note(`From now on: ${now.width}×${now.height}, ${this.drawOpts.steps} steps.`);
        return true;
      }
      case 'edit': case 'load': {
        if (this.mode !== 'image') return false;
        const file = text.slice(cmd.length + 1).trim();
        if (!file) { this.note('Say which picture: /edit ~/Desktop/photo.jpg (or drag it in)'); return true; }
        if (this.drawing()) { this.note('Still drawing — ^C stops it.'); return true; }
        this.load(require('./sageimage').droppedPath(file, this.root) || file);
        return true;
      }
      case 'seconds': {
        if (this.mode !== 'video') return false;
        const n = Number(arg);
        if (!(n > 0 && Number.isFinite(n))) { this.note('Say how long: /seconds 6', 'err'); return true; }
        this.clipOpts.seconds = n;
        this.note(`From now on: ${n} s${n > 2 ? ` (filmed in ${Math.ceil(n / 2)} parts of 2 s, about ${Math.ceil(n / 2) * 18} minutes)` : ''}.`);
        return true;
      }
      case 'sound':
        if (this.mode !== 'video') return false;
        this.clipOpts.sound = arg ? !/^(off|no|0)$/i.test(arg) : !this.clipOpts.sound;
        this.note(this.clipOpts.sound ? 'Clips get a soundtrack.' : 'Clips are silent.');
        return true;
      case 'exact':
        if (!this.media) return false;
        this.exact = !this.exact;
        this.note(this.exact ? 'Drawing from your words exactly as you write them.' : 'Sage writes a detailed prompt from your words first.');
        return true;
      case 'open':
        if (this.mode === 'video') {
          if (this.clip) require('./sageimage').openFile(this.clip); else this.note('No clip yet.');
          return true;
        }
        if (this.picture) {
          const last = [...this.items].reverse().find((i) => i.type === 'image' && i.out === this.picture);
          require('./sageimage').openFile((last && last.source) || this.picture);
        }
        else this.note('No picture yet.');
        return true;
      case 'resume': case 'continue': {
        if (this.busy || this.drawing()) { this.note('Sage is busy — ^C stops it first.'); return true; }
        const conv = conversations.latest(this.mode, this.mode === 'code' ? this.root : null, this.id);
        if (!conv) { this.note(`No earlier ${this.mode === 'chat' ? 'chat' : `${this.mode} conversation`}${this.mode === 'code' ? ' in this folder' : ''} to pick up.`); return true; }
        if (!this.media && this.status === 'ready') { this.engine.send({ op: 'reset' }); this.status = 'loading'; }
        this.resume(conv);
        this.note(`Picked up “${conv.title}” — Sage remembers it.`);
        return true;
      }
      case 'suggest': case 'suggestions': {
        if (this.media) return false;
        const on = !/^(off|no|0)$/i.test(text.slice(cmd.length + 1).trim());
        this.engine.send({ op: 'suggest', on });
        if (!on) this.suggestion = null;
        this.note(on ? 'Sage suggests what you might say next (Tab takes it).' : 'No more suggestions.');
        return true;
      }
      case 'think': case 'thinking': {
        const arg = text.slice(cmd.length + 1).trim().toLowerCase();
        if (this.media) return false;
        if (!arg) { this.note(`Thinking: ${this.thinking} — ${this.thinkInfo(this.thinking)}. /think ${THINKING.join(' | ')} (or ^T) changes it${this.thinks ? '' : '; Sage Lite doesn’t think'}.`); return true; }
        this.setThinking({ xhigh: 'high', on: 'medium', none: 'off', no: 'off' }[arg] || arg, true);
        return true;
      }
      case 'help':
        if (this.mode === 'video') { this.note('Describe a clip; then say how to change it (a new version), or “keep going” to make it longer.\n/seconds 6  ·  /sound off  ·  /exact  your words as they are  ·  /open  play the latest  ·  /new  ·  /exit'); return true; }
        if (this.mode === 'image') { this.note('Describe a picture, then say how to change it.\n/edit <file>  change a picture of yours (or drag it in)  ·  /exact  your words as they are, not Sage’s prompt  ·  /size 512  ·  /steps 20  ·  /open  ·  /new  ·  /exit'); return true; }
        this.note(`/new  a fresh conversation  ·  /image <prompt>  draw a picture  ·  /model [ultra|pro|flash|lite]  switch models  ·  /think [off|low|medium|high]  how much Sage thinks  ·  /resume  pick up your last conversation  ·  /suggest off  no suggestions  ·  /exit  leave\n^O models · ^T thinking · ^N new chat · PgUp/PgDn or the wheel scroll · ^C stops an answer (or leaves)${this.mode === 'code' ? ' · y / a / n answer a change' : ''}`);
        return true;
      default: return false;
    }
  }

  newChat() {
    if (this.busy) { this.note('Sage is still answering — ^C stops it.'); return; }
    if (this.media) {
      if (this.drawing()) { this.note('Still working — ^C stops it.'); return; }
      this.clip = null;
      this.clipName = null;
      this.picture = null;
      this.pictureName = null;
      this.fitted = null;
      this.scene = null;
      this.changes = [];
      this.items = [];
      this.id = conversations.newId();
      this.changed();
      return;
    }
    this.items = [];
    this.allowAll = false;
    this.scroll = 0;
    this.suggestion = null;
    this.id = conversations.newId(); // the old one stays kept
    if (this.status === 'ready') { this.engine.send({ op: 'reset' }); this.status = 'loading'; }
    this.changed();
  }

  switchModel(key) {
    this.menu = null;
    const m = this.models.find((x) => x.key === key);
    if (!m) return;
    if (key === this.model && this.status !== 'error') { this.changed(); return; }
    const mi = modelInfo(this.mode, key);
    if (!m.ready) { this.note(`${mi.label} isn’t set up — run: sage --${mi.flag} --setup`, 'err'); return; }
    if (this.approval) this.answer('n');
    this.suggestion = null;
    this.engine.close();
    if (this.items.some((i) => i.type === 'user')) this.note(`Switched to ${mi.label} — it has the conversation so far.`);
    this.useModel(key);
    this.remember();
  }

  openMenu() {
    if (this.media) return; // one model: nothing to pick
    this.menu = { index: Math.max(0, this.models.findIndex((m) => m.key === this.model)) };
    this.changed();
  }

  // /image: draws a picture in the background; the conversation goes on.
  image(prompt) {
    const img = require('./sageimage');
    if (!this.startImage) { this.note('Sage can’t draw yet — set it up in the shell: sage image --setup', 'err'); return; }
    if (this.drawing()) { this.note('Sage is already drawing — one picture at a time.'); return; }
    const o = img.parseArgs(prompt.split(/\s+/).filter(Boolean));
    if (o.error) { this.note(o.error.replace('sage image', '/image'), 'err'); return; }
    if (o.images.length) { // /image --edit photo.jpg make it night
      const p = img.prepare(o.images[0], this.root);
      if (p.error) { this.note(`Can’t edit that: ${p.error}.`, 'err'); return; }
      o.images = [p.file];
      if (!o.sized) Object.assign(o, img.fitSize(p.width, p.height, Math.max(o.width, o.height)));
    }
    o.output = path.basename(img.outputPath(o.output || o.prompt, this.root)); // named after your words
    const item = { type: 'image', prompt: o.prompt, size: `${o.width}×${o.height}`, job: null, state: 'running', step: 0, total: o.steps, started: Date.now() };
    this.items.push(item);
    this.scroll = 0;
    if (!o.exact && this.status !== 'error') {
      // The model that's chatting writes the detailed prompt (apart from the
      // conversation) — no second copy of it in memory next to the image model.
      item.id = (this.imageIds = (this.imageIds || 0) + 1);
      item.options = o;
      item.phase = 'prompt';
      item.writer = modelInfo(this.mode, this.model).label;
      this.engine.send({ op: 'image-prompt', id: item.id, prompt: o.prompt, edit: o.images.length > 0, context: null });
      this.changed();
      return;
    }
    this.startDrawing(item, o);
  }

  // Sage's prompt for /image is back: draw from it (or from the words).
  onImagePrompt(ev) {
    const item = this.items.find((i) => i.type === 'image' && i.id === ev.id);
    if (!item || item.state !== 'running' || item.job) return;
    if (ev.stopped) { item.state = 'stopped'; item.v = (item.v || 0) + 1; return; }
    item.detailed = ev.text || null;
    if (!ev.text) item.unwritten = 'Sage wrote nothing';
    this.startDrawing(item, { ...item.options, prompt: ev.text || item.options.prompt });
  }

  startDrawing(item, o) {
    try { item.job = this.startImage(o); } catch (e) {
      item.state = 'failed';
      item.error = e.message;
      item.v = (item.v || 0) + 1;
      this.changed();
      return;
    }
    item.phase = 'draw';
    item.started = Date.now();
    item.v = (item.v || 0) + 1;
    this.changed();
  }

  // Image chat: a picture of yours to change — a file, or one already
  // prepared by sageimage.prepare ({ file, source, width, height }).
  load(file) {
    const img = require('./sageimage');
    const p = typeof file === 'string' ? img.prepare(file, this.root) : file;
    if (p.error) { this.note(`Can’t edit that: ${p.error}.`, 'err'); return; }
    this.picture = p.file;
    this.pictureName = path.basename(p.source).replace(/\.[^.]+$/, '');
    this.fitted = img.fitSize(p.width, p.height, Math.max(this.drawOpts.width, this.drawOpts.height));
    this.scene = null; // Sage can't see it: edits are written from your words alone
    this.changes = [];
    this.items.push({ type: 'image', loaded: true, state: 'done', out: p.file, source: p.source, size: `${this.fitted.width}×${this.fitted.height}` });
    this.scroll = 0;
    this.changed();
  }

  // Image chat: the first message draws; each one after edits the latest picture.
  draw(text) {
    if (!this.startImage) { this.note('Sage can’t draw yet — set it up in the shell: sage image --setup', 'err'); return; }
    const img = require('./sageimage');
    const edit = !!this.picture;
    if (!edit) this.pictureName = text;
    const o = { ...this.drawOpts, ...(edit && this.fitted), prompt: text, seed: null, open: false, images: edit ? [this.picture] : null, exact: this.exact };
    if (edit && (this.scene || this.changes.length)) {
      o.context = [this.scene, this.changes.length && `It has since been changed: ${this.changes.join('; ')}.`].filter(Boolean).join(' ');
    }
    o.output = path.basename(img.outputPath(this.pictureName, this.root));
    let job;
    try { job = this.startImage(o); } catch (e) { this.note(`Couldn’t start drawing: ${e.message}`, 'err'); return; }
    this.items.push({ type: 'image', edit, prompt: text, size: `${o.width}×${o.height}`, job, state: 'running', step: 0, total: o.steps, started: Date.now(), writer: job.writer ? job.writer.label : null });
    this.scroll = 0;
    this.changed();
  }

  // Video chat: the first message films a clip; after that, "keep going"
  // makes it longer (carrying on from its last frame) and anything else
  // films a new version, Sage rewriting the prompt with the change.
  film(text) {
    if (!this.startVideo) { this.note('Sage can’t film yet — set it up in the shell: sage video --setup', 'err'); return; }
    const img = require('./sageimage');
    const extend = !!this.clip && /^(keep going|go on|continue|carry on|longer|more|extend|make it longer)\b/i.test(text);
    const first = !this.clip;
    if (first) this.clipName = text;
    const words = [this.clipName, ...this.changes].join('; ');
    const o = { width: 1280, height: 704, steps: 4, seed: null, open: false, ...this.clipOpts, words, exact: this.exact, prompt: text };
    if (extend) Object.assign(o, { prompt: this.scene || this.clipName, exact: true, previous: this.clip }); // the same scene, carried on
    else if (!first) o.context = [this.scene, this.changes.length && `It has since been changed: ${this.changes.join('; ')}.`].filter(Boolean).join(' ');
    o.output = path.basename(img.outputPath(this.clipName, this.root, '.mp4'));
    if (!this.posters) this.posters = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-posters-'));
    o.poster = path.join(this.posters, `${this.items.length}.png`);
    let job;
    try { job = this.startVideo(o); } catch (e) { this.note(`Couldn’t start filming: ${e.message}`, 'err'); return; }
    const kind = extend ? 'extend' : first ? 'film' : 'refilm';
    this.items.push({ type: 'video', kind, prompt: text, size: `${o.width}×${o.height}`, length: o.seconds, job, poster: o.poster, state: 'running', step: 0, total: o.steps, started: Date.now(), writer: job.writer ? job.writer.label : null });
    this.scroll = 0;
    this.changed();
  }

  drawing() { return this.items.find((i) => (i.type === 'image' || i.type === 'video') && i.state === 'running') || null; }

  // Checks on a picture being drawn; the loop calls it between keys.
  tick() {
    const item = this.drawing();
    if (!item || !item.job) return; // no job yet: Sage is writing its prompt
    const p = item.job.poll();
    const detailed = p.detailed || item.detailed; // from the job's writer, or from the chat's model
    const where = [p.step, p.total, p.phase, p.stage, p.segment, p.piece].join();
    if (p.state === 'running' && where === item.where && detailed === item.detailed) return;
    Object.assign(item, { where, step: p.step, total: p.total, phase: p.phase, stage: p.stage, segment: p.segment, segments: p.segments, detailed, unwritten: p.unwritten || item.unwritten });
    if (p.state !== 'running') {
      item.state = p.state;
      item.seconds = Math.round((Date.now() - item.started) / 1000);
      item.out = item.job.out;
      item.error = p.error;
      item.job.cleanup();
      if (p.state === 'done' && this.mode === 'video') {
        this.clip = item.out; // the next message changes or extends this
        if (item.kind === 'extend') { /* the same scene, longer */ } else if (item.detailed) { this.scene = item.detailed; this.changes = []; } // Sage's prompt has every change in it
        else if (item.kind === 'film') { this.scene = item.prompt; this.changes = []; }
        else this.changes.push(item.prompt);
      } else if (p.state === 'done' && this.mode === 'image') {
        this.picture = item.out; // the next message edits this
        if (item.edit) this.changes.push(item.prompt);
        else { this.scene = item.detailed || item.prompt; this.changes = []; }
      }
      else if (p.state === 'done') item.shown = require('./sageimage').show(item.out, () => {});
    }
    item.v = (item.v || 0) + 1;
    this.changed();
  }

  interrupt() {
    if (this.menu) { this.menu = null; this.changed(); return; }
    const drawing = this.drawing();
    if (drawing && !this.busy && !this.approval) { // ^C stops the picture first
      if (drawing.job) { drawing.job.stop(); drawing.job.cleanup(); } else this.engine.interrupt(); // or Sage's prompt for it
      drawing.state = 'stopped';
      drawing.v = (drawing.v || 0) + 1;
      this.changed();
      return;
    }
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
    if (text) this.suggestion = null;
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
    if (k.ctrl && k.name === 't') { this.cycleThinking(); return; }
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
    if ((k.name === 'tab' || k.name === 'right') && !s && this.suggestion) { this.setInput(this.suggestion); return; } // take the suggestion
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
    if (hit && hit.action === 'menu' && this.media) return; // nothing to pick
    if (hit && hit.action === 'menu') { if (this.menu) { this.menu = null; this.changed(); } else this.openMenu(); return; }
    if (hit && hit.action === 'model') { this.switchModel(hit.key); return; }
    if (hit && hit.action === 'think') { this.cycleThinking(); return; }
    if (hit && hit.action === 'answer') { this.answer(hit.choice); return; }
    if (hit && hit.action === 'try') { this.setInput(hit.text); return; }
    if (hit && hit.action === 'open') { require('./sageimage').openFile(hit.file); return; }
    if (this.menu) { this.menu = null; this.changed(); }
  }

  close() {
    const drawing = this.drawing();
    if (drawing) { drawing.job.stop(); drawing.job.cleanup(); }
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
  if (item.type === 'thought') {
    // the model's thinking, muted, under a heading that says how long it took
    const time = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
    lines.push({ s: `${muted}◇ ${item.done ? `Thought for ${time(item.seconds)}` : 'Thinking…'}${RESET()}` });
    for (const l of wrap(item.text.trim(), w - 4)) lines.push({ s: `  ${muted}│ ${l}${RESET()}` });
    return lines;
  }
  if (item.type === 'sage') {
    const text = item.text.replace(/^\s+/, '');
    const md = text ? renderMarkdown(text, { width: w - 2 }).split('\n') : [''];
    md.forEach((l, i) => lines.push({ s: `${i ? '  ' : `${hilite('✦')} `}${l}${RESET()}` }));
    if (!item.done && app && app.status === 'writing') lines[lines.length - 1].s += `${muted}▍${RESET()}`;
    return lines;
  }
  if (item.type === 'video') {
    const color = { running: theme.fg('accent'), done: theme.fg('ok'), failed: theme.fg('err') }[item.state] || muted;
    const time = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
    const part = item.segments > 1 ? `part ${item.segment}/${item.segments} · ` : '';
    let detail;
    if (item.state === 'running') {
      if (item.phase === 'prompt') detail = `${item.writer} is writing a detailed prompt…`;
      else if (item.stage === 'sound') detail = 'adding sound…';
      else if (item.stage === 'decode') detail = `${part}developing the frames…`;
      else if (item.stage === 'denoise') {
        const barW = Math.max(4, Math.min(16, w - 40));
        const filled = Math.round((item.total ? item.step / item.total : 0) * barW);
        detail = `${part}${item.step}/${item.total} ${theme.fg('accent')}${'━'.repeat(filled)}${muted}${'━'.repeat(barW - filled)}`;
      } else detail = `${part}reading the prompt…`;
      detail += `${muted} · ${time(Math.round((Date.now() - item.started) / 1000))}`;
    } else if (item.state === 'done') detail = `saved ${path.relative(app ? app.root : '', item.out) || item.out} · ${time(item.seconds)}`;
    else if (item.state === 'failed') detail = `didn’t work: ${item.error}`;
    else detail = 'stopped';
    const title = { film: 'Clip', refilm: 'New version', extend: 'Longer' }[item.kind] || 'Clip';
    lines.push({ s: `${color}●${RESET()} ${ansi.bold()}${title}${RESET()} ${muted}${item.size} · ${item.kind === 'extend' ? '+' : ''}${item.length} s${RESET()}  ${muted}${detail}${RESET()}` });
    if (item.kind === 'film') for (const l of wrap(`“${item.prompt}”`, w - 2).slice(0, 3)) lines.push({ s: `  ${theme.fg('accent')}${l}${RESET()}` });
    if (item.detailed) {
      const said = wrap(item.detailed, w - 4);
      const shown = said.length > 4 ? [...said.slice(0, 3), `${said[3].slice(0, Math.max(0, w - 6))}…`] : said;
      shown.forEach((l, i) => lines.push({ s: `  ${muted}${i ? ' ' : '✎'} ${l}${RESET()}` }));
    } else if (item.unwritten) lines.push({ s: `  ${muted}✎ from your words — ${item.unwritten}${RESET()}` });
    const fitted = lines.map((l) => ({ s: tui.textWidth(ansi.strip(l.s)) > w ? fitText(ansi.strip(l.s), w) : l.s }));
    if (item.state === 'done') {
      // a frame of it, in half blocks; click it to play the clip
      const cols = Math.max(8, Math.min(w - 2, 48));
      const thumb = item.poster ? require('./png').thumbnailFile(item.poster, cols) : [];
      for (const l of thumb) fitted.push({ s: `  ${l}`, hits: [{ x0: 2, x1: 2 + cols, action: 'open', file: item.out }] });
      if (thumb.length) fitted.push({ s: `  ${muted}▶ click to play${RESET()}`, hits: [{ x0: 2, x1: 17, action: 'open', file: item.out }] });
    }
    return fitted;
  }
  if (item.type === 'image') {
    const color = { running: theme.fg('accent'), done: theme.fg('ok'), failed: theme.fg('err') }[item.state] || muted;
    const time = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
    let detail;
    if (item.state === 'running' && item.phase === 'prompt') detail = `${item.writer} is writing a detailed prompt…`;
    else if (item.state === 'running') {
      const barW = Math.max(4, Math.min(20, w - 30));
      const f = item.total ? item.step / item.total : 0;
      const filled = Math.round(f * barW);
      detail = `${item.step ? `${item.step}/${item.total} ` : 'reading the prompt… '}${theme.fg('accent')}${'━'.repeat(filled)}${muted}${'━'.repeat(barW - filled)}`;
    } else if (item.state === 'done') detail = `saved ${path.relative(app ? app.root : '', item.out) || item.out} · ${time(item.seconds)}${item.shown === 'preview' ? ' · opened in Preview' : ''}`;
    else if (item.state === 'failed') detail = `didn’t work: ${item.error}`;
    else detail = 'stopped';
    if (item.loaded) detail = `${path.basename(item.source)} · say how to change it`;
    lines.push({ s: `${color}●${RESET()} ${ansi.bold()}${item.loaded ? 'Your picture' : item.edit ? 'Edit' : 'Image'}${RESET()} ${muted}${item.size}${RESET()}  ${muted}${detail}${RESET()}` });
    if (!item.edit && !item.loaded) for (const l of wrap(`“${item.prompt}”`, w - 2).slice(0, 3)) lines.push({ s: `  ${theme.fg('accent')}${l}${RESET()}` });
    if (item.detailed) { // what Sage wrote for the image model
      const said = wrap(item.detailed, w - 4);
      const shown = said.length > 4 ? [...said.slice(0, 3), `${said[3].slice(0, Math.max(0, w - 6))}…`] : said;
      shown.forEach((l, i) => lines.push({ s: `  ${muted}${i ? ' ' : '✎'} ${l}${RESET()}` }));
    } else if (item.unwritten) lines.push({ s: `  ${muted}✎ from your words — ${item.unwritten}${RESET()}` });
    const fitted = lines.map((l) => ({ s: tui.textWidth(ansi.strip(l.s)) > w ? fitText(ansi.strip(l.s), w) : l.s }));
    if (item.state === 'done' && app && app.mode === 'image') {
      // the picture itself, in half blocks; click it to open it in Preview
      const cols = Math.max(8, Math.min(w - 2, 48));
      const thumb = require('./png').thumbnailFile(item.out, cols);
      for (const l of thumb) fitted.push({ s: `  ${l}`, hits: [{ x0: 2, x1: 2 + cols, action: 'open', file: item.source || item.out }] });
    }
    return fitted;
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
  const lines = app.mode === 'video'
    ? ['Sage Video: describe a clip — Sage films it, with sound.', 'Then say how to change it, or “keep going” to make it longer.',
      `Each version is saved in ${tildify(app.root)}. It's slow: about 18 minutes for every 2 seconds.`]
    : app.mode === 'image'
    ? ['Sage Image: describe a picture, then change it by talking to it —', '“make it night”, “add a red umbrella”, “now in watercolour”.',
      `Each version is saved in ${tildify(app.root)}; /new starts a new picture.`,
      'To change a picture of yours, drag it in here or type /edit photo.jpg.']
    : app.mode === 'code'
    ? ['Sage Code: your AI pair programmer, on your Mac.', `It reads, writes and edits files and runs commands in ${tildify(app.root)}.`,
      'Every change and command is shown and asked first;', 'replaced files go to the Trash, never lost.']
    : ['An AI that runs entirely on your Mac.', 'Private · offline · no account · no API key.'];
  for (const l of lines) for (const part of wrap(l, w)) out.push(center(part, `${part}`));
  out.push({ s: '' });
  const tries = app.mode === 'video'
    ? ['a golden retriever puppy running through sunflowers', 'waves crashing on black rocks at sunset, slow motion', 'a steam train crossing a snowy bridge']
    : app.mode === 'image'
    ? ['a cozy cabin in a snowy forest at night, warm light', 'a red panda reading under a cherry tree, watercolor', 'a retro poster of a rocket over Mars']
    : app.mode === 'code'
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
  const info = modelInfo(app.mode, app.model) || { label: app.model };
  const working = (d) => (d.phase === 'prompt' ? 'writing a prompt'
    : d.type !== 'video' ? `drawing ${d.step}/${d.total}`
    : d.stage === 'sound' ? 'adding sound'
    : `filming${d.segments > 1 ? ` part ${d.segment}/${d.segments}` : ''}`);
  const drop = app.mode === 'video' ? ' ◆ Sage Video ' : app.mode === 'image' ? ' ◆ Sage Image ' : ` ◆ ${info.label} ${app.menu ? '▴' : '▾'} `;
  const spin = SPIN[Math.floor(now / 90) % SPIN.length];
  const status = {
    loading: `${spin} waking ${info.label}…`, ready: app.drawing() ? `${spin} ${working(app.drawing())}` : app.speed ? `ready · ${app.speed.toFixed(1)} tok/s` : 'ready',
    thinking: `${spin} thinking`, writing: `${spin} writing`, waiting: 'waiting for you', running: `${spin} running a command`, stopping: `${spin} stopping`, error: 'not running',
  }[app.status] || app.status;
  const brand = ' ✦ Sage';
  const pill = ` ${app.mode} `;
  const left = `${brand} ${pill}`;
  // Sage Ultra's thinking level, a button left of the dropdown (click or ^T)
  let think = app.thinks ? ` ◇ thinking ${app.thinking} ` : '';
  if (W - tui.textWidth(left) - tui.textWidth(drop) - tui.textWidth(think) < 8) think = '';
  const thinkW = tui.textWidth(think);
  const dropW = tui.textWidth(drop) + thinkW;
  const room = W - tui.textWidth(left) - dropW;
  const full = ` ${status} `;
  const statusText = room < 5 ? '' : tui.textWidth(full) <= room ? full : fitText(full, room);
  const gap = Math.max(0, W - tui.textWidth(left) - tui.textWidth(statusText) - dropW);
  let header;
  if (W >= tui.textWidth(left) + dropW) {
    const thinkBtn = think ? `${barBg}${theme.fg('accent')}${think}${RESET()}` : '';
    header = `${barBg}${barFg}${ansi.bold()}${brand}${RESET()}${barBg} ${theme.bg(ui.select.bg)}${ansi.fg(ui.select.fg)}${pill}${RESET()}${barBg}${barFg}${' '.repeat(gap)}${statusText}${thinkBtn}${theme.bg(ui.select.bg)}${ansi.fg(ui.select.fg)}${ansi.bold()}${drop}${RESET()}`;
    if (think) hits.push({ y: 0, x0: W - dropW, x1: W - dropW + thinkW, action: 'think' });
    hits.push({ y: 0, x0: W - dropW + thinkW, x1: W, action: 'menu' });
  } else {
    header = tui.bar(` ✦ Sage · ${info.label} ▾`, W);
    hits.push({ y: 0, x0: 0, x1: W, action: 'menu' });
  }

  // input box
  const inner = Math.max(4, W - 6);
  const prompt = app.approval ? 'answer above: y / a / n' : app.mode === 'code' ? 'Tell Sage what to build or fix…'
    : app.mode === 'video' ? (app.clip ? 'Say how to change it, or “keep going”…' : 'Describe a clip…')
    : app.mode === 'image' ? (app.picture ? 'Say how to change it…' : 'Describe a picture…') : 'Ask Sage anything…';
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
    const hint = app.suggestion && !app.approval && !app.busy ? `${app.suggestion}  ⇥` : prompt; // Sage's guess at your next message
    const content = !app.input && i === 0 ? `${muted}${fitText(hint, inner)}${RESET()}` : fitText(l, inner);
    box.push(`${frame}│${RESET()} ${i === 0 ? `${theme.fg('accent2')}${ansi.bold()}❯${RESET()}` : ' '} ${content} ${frame}│${RESET()}`);
  });
  box.push(`${frame}╰${'─'.repeat(W - 2)}╯${RESET()}`);
  const keysHelp = app.approval ? `y yes${app.approval.item.risky ? '' : ' · a yes to all'} · n no (Esc) · ^C stop`
    : app.busy ? '^C stop · PgUp/PgDn scroll'
      : app.mode === 'video' ? `enter ${app.clip ? 'change' : 'film'} · /seconds 6 · /sound ${app.clipOpts.sound ? 'off' : 'on'} · /new · /open · ^C ${app.drawing() ? 'stop' : 'quit'}`
      : app.mode === 'image' ? `enter ${app.picture ? 'edit' : 'draw'} · /edit file · /new · /size 512 · /steps 20 · /open · ^C ${app.drawing() ? 'stop' : 'quit'}`
        : `${app.suggestion && !app.input ? 'tab use suggestion · ' : ''}enter send · ⌥enter new line · ^O model${app.thinks ? ' · ^T thinking' : ''} · ^N new chat · /help · ^C quit`;
  const footer = `${muted}${fitText(` ${keysHelp}`, W).trimEnd()}${RESET()}`;

  // transcript
  const bodyH = Math.max(1, rows - 1 - box.length - 1);
  const w = Math.max(8, W - 4);
  let body = [];
  if (!app.items.length) body = welcome(app, w);
  for (const item of app.items) {
    if ((item.type === 'sage' || item.type === 'thought') && !item.text.trim()) continue; // only whitespace between tool calls
    body.push({ s: '' }); // a blank line above each item, the first too
    const key = `${w}:${item.v || 0}:${item.state || ''}:${app.approval && app.approval.item === item}:${item.type === 'sage' && !item.done ? app.status : ''}${item.type === 'video' && item.state === 'running' ? `:${Math.floor((now - item.started) / 1000)}` : ''}`; // a clip's clock ticks
    if (!item.cache || item.cacheKey !== key) { item.cache = itemLines(item, w, app); item.cacheKey = key; }
    body.push(...item.cache);
  }
  const writing = app.lastSage();
  const last = app.items[app.items.length - 1];
  const showing = (writing && writing.text.trim()) || (last && last.type === 'thought' && !last.done && last.text.trim()); // the thinking is on screen
  if ((app.status === 'thinking' || app.status === 'stopping') && !showing) {
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
      const mi = modelInfo(app.mode, m.key) || { label: m.key, blurb: '' };
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

const IDLE_MS = (Number(process.env.MAXSHELL_SAGE_IDLE) || 600) * 1000; // the model rests after this long unused

function loop(app, { input = 0, output = process.stdout, keep = true } = {}) {
  const reader = new KeyReader(input);
  // The conversation is kept as it goes (src/conversations.js), so Sage remembers it.
  let kept = app.version;
  let keptAt = 0;
  const save = (now) => {
    if (!keep || app.version === kept || (!now && Date.now() - keptAt < 1500)) return;
    kept = app.version;
    keptAt = Date.now();
    try { conversations.save({ id: app.id, mode: app.mode, root: app.root, model: app.model, items: app.items }); } catch { /* not this time */ }
  };
  let drawn = '';
  let last = null;
  let lastSpin = 0;
  const draw = (force) => {
    const now = Date.now();
    const spinning = (app.status !== 'ready' && app.status !== 'error' && app.status !== 'waiting') || !!app.drawing();
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
  let used = Date.now();
  while (!app.done) {
    const k = reader.next(40);
    if (k.name !== 'timeout' || app.busy || app.status === 'loading') used = Date.now();
    else if (Date.now() - used > IDLE_MS && app.rest()) used = Date.now();
    if (k.name === 'mouse') {
      const hit = last && last.hits.find((h) => h.y === k.y - 1 && k.x - 1 >= h.x0 && k.x - 1 < h.x1);
      app.mouse(k, hit);
    } else if (k.name !== 'timeout') {
      app.key(k);
    }
    for (const ev of app.engine.poll()) app.onEvent(ev);
    app.tick();
    if (!app.done) draw(false);
    if (app.toRun) { app.work(); draw(true); }
    save(false);
  }
  save(true);
  app.close();
  return 0;
}

module.exports = { IDLE, Engine, SageApp, render, wrap, itemLines, loop, MODEL_INFO, modelInfo };
