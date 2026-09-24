'use strict';

const fs = require('fs');

const ansi = require('./ansi');
const { KeyReader } = require('./keys');
const git = require('./git');

const POLL_MS = 2000;

const HELP_ROWS = [
  [['space', 'Stage'], ['a', 'Stage all'], ['U', 'Unstage all'], ['c', 'Commit'], ['^T', 'Push']],
  [['d', 'Discard'], ['r', 'Refresh'], ['^D/^U', 'Diff'], ['^G', 'Help'], ['q', 'Quit']],
];

const HELP_TEXT_LINES = `
 gitui — browse and stage your work without leaving maxshell

 Moving
   up / down, k / j   move between files
   ^D / ^U            scroll the diff pane
   PgUp / PgDn        scroll the diff a page at a time

 Staging
   space              stage the file, or unstage it if it is already staged
   a                  stage everything, including untracked files
   U                  unstage everything

 Committing
   c                  commit what is staged (asks for a message)
   ^T                 push (asks first, and names the remote)

 Careful
   d                  discard a file's changes, or delete it if untracked.
                      This cannot be undone, so it asks you to type 'yes'.

 Other
   r                  re-read the repository
   ^G                 this help
   q or ^X            quit

 The status is re-read every couple of seconds, so commits or checkouts you
 make in another terminal show up on their own.
`.split('\n');

const SECTION_COLOR = {
  staged: 'green',
  unstaged: 'yellow',
  untracked: 'gray',
  conflicted: 'red',
};

class GitUI {
  constructor({ shell, io, output }) {
    this.shell = shell;
    this.io = io;
    this.output = output || process.stdout;

    this.status = git.emptyStatus();
    this.rows = [];
    this.sel = 0;
    this.listTop = 0;
    this.diffLines = [];
    this.diffTop = 0;
    this.diffKey = null;
    this.message = '';
    this.mode = 'list';
    this.prompt = null;
    this.view = null;
    this.viewTitle = '';
    this.viewTop = 0;
    this.done = false;
    this.exitStatus = 0;
    this.lastPoll = 0;
  }

  get cwd() { return this.shell.cwd; }

  get termRows() { return this.output.rows || 24; }

  get termCols() { return this.output.columns || 80; }

  // --- model ----------------------------------------------------------------

  buildRows() {
    const rows = [];
    const section = (name, label, list) => {
      if (!list.length) return;
      rows.push({ kind: 'header', section: name, text: `${label} (${list.length})` });
      for (const entry of list) rows.push({ kind: 'entry', section: name, entry });
    };
    section('conflicted', 'Conflicted', this.status.conflicted);
    section('staged', 'Staged', this.status.staged);
    section('unstaged', 'Unstaged', this.status.unstaged);
    section('untracked', 'Untracked', this.status.untracked);
    return rows;
  }

  selectedEntry() {
    const row = this.rows[this.sel];
    return row && row.kind === 'entry' ? row : null;
  }

  // Re-reads the repository, keeping the same file selected where possible.
  refresh() {
    const previous = this.selectedEntry();
    this.status = git.status(this.cwd);
    this.rows = this.buildRows();

    let index = -1;
    if (previous) {
      index = this.rows.findIndex((r) => r.kind === 'entry'
        && r.entry.path === previous.entry.path
        && r.section === previous.section);
      if (index === -1) {
        index = this.rows.findIndex((r) => r.kind === 'entry' && r.entry.path === previous.entry.path);
      }
    }
    if (index === -1) index = this.rows.findIndex((r) => r.kind === 'entry');
    this.sel = index === -1 ? 0 : index;

    this.diffKey = null;
    this.updateDiff();
  }

  signature() {
    const s = this.status;
    const part = (list) => list.map((e) => `${e.code}${e.path}`).join(',');
    return [s.branch, s.ahead, s.behind, part(s.staged), part(s.unstaged), part(s.untracked)].join('|');
  }

  moveSel(delta) {
    let i = this.sel;
    for (let n = 0; n < this.rows.length; n++) {
      i += delta;
      if (i < 0 || i >= this.rows.length) return false;
      if (this.rows[i].kind === 'entry') {
        this.sel = i;
        this.updateDiff();
        return true;
      }
    }
    return false;
  }

  updateDiff() {
    const row = this.selectedEntry();
    if (!row) {
      this.diffLines = [];
      this.diffTop = 0;
      return;
    }
    const key = `${row.section}:${row.entry.path}`;
    if (key === this.diffKey) return;
    this.diffKey = key;
    const text = git.diff(this.cwd, row.entry, row.section);
    this.diffLines = text ? text.replace(/\n$/, '').split('\n') : ['(nothing to show)'];
    this.diffTop = 0;
  }

  // --- rendering ------------------------------------------------------------

  bar(text) {
    const cols = this.termCols;
    const padded = text.length > cols ? text.slice(0, cols) : text.padEnd(cols);
    return `${ansi.reverse()}${padded}${ansi.reset()}`;
  }

  titleBar() {
    const s = this.status;
    const branch = s.branch || '(no branch)';
    const track = `${s.ahead ? ` ↑${s.ahead}` : ''}${s.behind ? ` ↓${s.behind}` : ''}`;
    const counts = `${s.staged.length} staged, ${s.unstaged.length} changed, ${s.untracked.length} untracked`;
    const left = `  gitui  on ${branch}${track}`;
    const room = this.termCols - left.length - counts.length - 2;
    return this.bar(left + (room > 0 ? ' '.repeat(room) : '  ') + counts);
  }

  separator(label) {
    const cols = this.termCols;
    const text = ` ${label} `;
    const dashes = Math.max(0, cols - text.length - 2);
    return `${ansi.fg('gray')}──${text}${'─'.repeat(dashes)}${ansi.reset()}\x1b[K`;
  }

  renderRow(row, selected) {
    if (row.kind === 'header') {
      return `${ansi.bold()}${ansi.fg(250)} ${row.text}${ansi.reset()}\x1b[K`;
    }
    const text = `  ${selected ? '▸' : ' '} ${row.entry.code} ${row.entry.path}`;
    if (selected) return `${ansi.reverse()}${text.slice(0, this.termCols).padEnd(this.termCols)}${ansi.reset()}`;
    return `${ansi.fg(SECTION_COLOR[row.section] || 'white')}${text.slice(0, this.termCols)}${ansi.reset()}\x1b[K`;
  }

  renderDiffLine(line) {
    const text = line.slice(0, this.termCols);
    let color = '';
    if (text.startsWith('+++') || text.startsWith('---')) color = ansi.bold();
    else if (text.startsWith('@@')) color = ansi.fg('cyan');
    else if (text.startsWith('+')) color = ansi.fg('green');
    else if (text.startsWith('-')) color = ansi.fg('red');
    else if (text.startsWith('diff ') || text.startsWith('index ')) color = ansi.fg('gray');
    return `${color}${text}${ansi.reset()}\x1b[K`;
  }

  layout() {
    const avail = Math.max(2, this.termRows - 5);
    const listH = Math.max(1, Math.min(Math.max(this.rows.length, 1), Math.floor(avail * 0.5)));
    return { listH, diffH: Math.max(1, avail - listH) };
  }

  render() {
    if (this.mode === 'help') return this.renderPager('gitui help', HELP_TEXT_LINES);
    if (this.mode === 'output') return this.renderPager(this.viewTitle, this.view || []);

    const { listH, diffH } = this.layout();
    if (this.sel < this.listTop) this.listTop = this.sel;
    if (this.sel >= this.listTop + listH) this.listTop = this.sel - listH + 1;

    let s = '\x1b[H';
    s += this.titleBar();

    for (let i = 0; i < listH; i++) {
      const row = this.rows[this.listTop + i];
      s += '\r\n';
      if (!row) {
        s += this.rows.length || i ? '\x1b[K' : `${ansi.fg('green')}  working tree clean${ansi.reset()}\x1b[K`;
        continue;
      }
      s += this.renderRow(row, this.listTop + i === this.sel);
    }

    const selected = this.selectedEntry();
    s += `\r\n${this.separator(selected ? `diff: ${selected.entry.path}` : 'diff')}`;

    for (let i = 0; i < diffH; i++) {
      const line = this.diffLines[this.diffTop + i];
      s += '\r\n';
      s += line === undefined ? '\x1b[K' : this.renderDiffLine(line);
    }

    s += '\r\n';
    if (this.mode === 'prompt') {
      s += this.bar(` ${this.prompt.label}${this.prompt.value}`);
    } else {
      s += `${ansi.fg(214)}${this.message.slice(0, this.termCols)}${ansi.reset()}\x1b[K`;
    }

    for (const row of HELP_ROWS) {
      let bar = '';
      for (const [k, label] of row) bar += `${ansi.reverse()}${k}${ansi.reset()} ${label.padEnd(11)}`;
      s += `\r\n${bar}\x1b[K`;
    }

    if (this.mode === 'prompt') {
      s += `\x1b[${this.termRows - 2};${this.prompt.label.length + this.prompt.value.length + 2}H`;
    }

    this.output.write(s);
  }

  renderPager(title, lines) {
    let s = `\x1b[H${this.bar(`  ${title}`)}`;
    const body = this.termRows - 2;
    for (let i = 0; i < body; i++) {
      const line = lines[this.viewTop + i];
      s += `\r\n${line === undefined ? '' : line.slice(0, this.termCols)}\x1b[K`;
    }
    s += `\r\n${this.bar('  ↑/↓ scroll   any other key returns')}`;
    this.output.write(s);
  }

  // --- actions --------------------------------------------------------------

  askPrompt(label, initial, onDone) {
    this.mode = 'prompt';
    this.prompt = { label, value: initial || '', onDone };
  }

  showOutput(title, text) {
    this.viewTitle = title;
    this.view = String(text).trim().split('\n');
    this.viewTop = 0;
    this.mode = 'output';
  }

  toggleStage() {
    const row = this.selectedEntry();
    if (!row) { this.message = 'nothing to stage'; return; }
    const staging = row.section !== 'staged';
    const res = staging ? git.stage(this.cwd, row.entry.path) : git.unstage(this.cwd, row.entry.path);
    this.message = res.ok
      ? `${staging ? 'staged' : 'unstaged'} ${row.entry.path}`
      : (res.stderr || 'git refused that');
    this.refresh();
  }

  stageAll() {
    const res = git.stageAll(this.cwd);
    this.message = res.ok ? 'staged everything' : (res.stderr || 'git refused that');
    this.refresh();
  }

  unstageAll() {
    const res = git.unstageAll(this.cwd);
    this.message = res.ok ? 'unstaged everything' : (res.stderr || 'git refused that');
    this.refresh();
  }

  askDiscard() {
    const row = this.selectedEntry();
    if (!row) return;
    if (row.section === 'staged') { this.message = 'unstage it first, with space'; return; }

    const deleting = row.section === 'untracked';
    const what = deleting
      ? `delete ${row.entry.path}`
      : `throw away your changes to ${row.entry.path}`;

    // Destructive and unrecoverable, so make it deliberate.
    this.askPrompt(`This will ${what}. Type yes to confirm: `, '', (value) => {
      if (value.trim().toLowerCase() !== 'yes') { this.message = 'left alone'; return; }
      if (deleting) {
        try {
          fs.rmSync(this.shell.resolve(row.entry.path), { recursive: true, force: true });
          this.message = `deleted ${row.entry.path}`;
        } catch (e) {
          this.message = `could not delete: ${e.code || e.message}`;
        }
      } else {
        const res = git.discard(this.cwd, row.entry.path);
        this.message = res.ok ? `discarded changes to ${row.entry.path}` : (res.stderr || 'git refused that');
      }
      this.refresh();
    });
  }

  askCommit() {
    if (!this.status.staged.length) { this.message = 'nothing staged to commit'; return; }
    this.askPrompt('Commit message: ', '', (value) => {
      const message = value.trim();
      if (!message) { this.message = 'commit cancelled'; return; }
      const res = git.commit(this.cwd, message);
      if (res.ok) this.message = `committed: ${message}`;
      else this.showOutput('commit failed', `${res.stdout}\n${res.stderr}`);
      this.refresh();
    });
  }

  askPush() {
    const upstream = git.describeRemote(this.cwd);
    const target = upstream || 'the default remote';
    this.askPrompt(`Push to ${target}? (y/n) `, '', (value) => {
      if (!/^y(es)?$/i.test(value.trim())) { this.message = 'push cancelled'; return; }
      const res = git.push(this.cwd);
      this.showOutput(res.ok ? 'pushed' : 'push failed', `${res.stdout}\n${res.stderr}` || 'no output');
      this.refresh();
    });
  }

  // --- keys -----------------------------------------------------------------

  handlePrompt(key) {
    const p = this.prompt;
    if (key.name === 'return') {
      this.mode = 'list';
      this.prompt = null;
      p.onDone(p.value);
      return;
    }
    if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
      this.mode = 'list';
      this.prompt = null;
      this.message = 'cancelled';
      return;
    }
    if (key.name === 'backspace') { p.value = p.value.slice(0, -1); return; }
    if (key.printable) p.value += key.str;
  }

  handlePager(key) {
    if (key.name === 'up') { this.viewTop = Math.max(0, this.viewTop - 1); return; }
    if (key.name === 'down') { this.viewTop++; return; }
    if (key.name === 'pageup') { this.viewTop = Math.max(0, this.viewTop - (this.termRows - 3)); return; }
    if (key.name === 'pagedown') { this.viewTop += this.termRows - 3; return; }
    this.mode = 'list';
    this.view = null;
  }

  scrollDiff(delta) {
    const max = Math.max(0, this.diffLines.length - 1);
    this.diffTop = Math.max(0, Math.min(max, this.diffTop + delta));
  }

  handleKey(key) {
    if (key.name === 'eof') { this.done = true; return; }
    if (this.mode === 'prompt') return this.handlePrompt(key);
    if (this.mode === 'help' || this.mode === 'output') return this.handlePager(key);

    this.message = '';
    const { diffH } = this.layout();

    if (key.ctrl) {
      switch (key.name) {
        case 'x': this.done = true; break;
        case 'g': this.mode = 'help'; this.viewTop = 0; break;
        case 't': this.askPush(); break;
        case 'd': this.scrollDiff(Math.floor(diffH / 2)); break;
        case 'u': this.scrollDiff(-Math.floor(diffH / 2)); break;
        case 'c': this.done = true; break;
        case 'l': this.output.write('\x1b[2J'); break;
        default: break;
      }
      return;
    }

    switch (key.name) {
      case 'up': this.moveSel(-1); return;
      case 'down': this.moveSel(1); return;
      case 'pageup': this.scrollDiff(-diffH); return;
      case 'pagedown': this.scrollDiff(diffH); return;
      case 'space': this.toggleStage(); return;
      case 'escape': return;
      default: break;
    }

    switch (key.str) {
      case 'k': this.moveSel(-1); break;
      case 'j': this.moveSel(1); break;
      case ' ': this.toggleStage(); break;
      case 'a': this.stageAll(); break;
      case 'U': this.unstageAll(); break;
      case 'd': this.askDiscard(); break;
      case 'c': this.askCommit(); break;
      case 'r': this.refresh(); this.message = 'refreshed'; break;
      case '?': this.mode = 'help'; this.viewTop = 0; break;
      case 'q': this.done = true; break;
      default: break;
    }
  }

  poll() {
    const now = Date.now();
    if (now - this.lastPoll < POLL_MS) return false;
    this.lastPoll = now;
    const before = this.signature();
    const status = git.status(this.cwd);
    const saved = this.status;
    this.status = status;
    if (this.signature() === before) { this.status = saved; return false; }
    this.status = saved;
    this.refresh();
    return true;
  }

  loop() {
    const reader = new KeyReader(0);
    this.refresh();
    this.render();
    while (!this.done) {
      const key = reader.next(POLL_MS);
      if (key.name === 'timeout') {
        if (this.poll()) this.render();
        continue;
      }
      this.handleKey(key);
      if (!this.done) this.render();
    }
    return this.exitStatus;
  }
}

function runGitUI(args, io, shell) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    shell.writeTo(io.stderr, 'gitui: needs an interactive terminal\n');
    return 1;
  }
  if (!git.isRepo(shell.cwd)) {
    shell.writeTo(io.stderr, 'gitui: not a git repository\n');
    return 1;
  }

  const ui = new GitUI({ shell, io });
  const wasRaw = process.stdin.isRaw;
  try {
    process.stdin.setRawMode(true);
    process.stdout.write('\x1b[?1049h\x1b[?25h');
    return ui.loop();
  } finally {
    process.stdout.write('\x1b[?1049l');
    try { process.stdin.setRawMode(!!wasRaw); } catch { /* not a tty any more */ }
  }
}

module.exports = { GitUI, runGitUI };
