'use strict';

const ansi = require('./ansi');
const gh = require('./github');
const theme = require('./theme');
const { fit, textWidth } = require('./tui');
const { ago } = require('./history');

const TABS = [
  { id: 'prs', label: 'Pull requests', load: gh.listPRs, empty: 'no open pull requests — n opens one for this branch' },
  { id: 'issues', label: 'Issues', load: gh.listIssues, empty: 'no open issues — n creates one' },
  { id: 'runs', label: 'Actions', load: gh.listRuns, empty: 'no workflow runs yet' },
];

const KEYS = '←→ tabs  ↑↓ select  enter details  o browser  n new  c checkout  m merge  r reload  esc back';

// The GitHub screen inside gitui: pull requests, issues and Actions runs.
class GitHubView {
  constructor(ui) {
    this.ui = ui;
    this.tab = 0;
    this.lists = {};
    this.errors = {};
    this.sel = { prs: 0, issues: 0, runs: 0 };
    this.top = { prs: 0, issues: 0, runs: 0 };
  }

  get current() { return TABS[this.tab]; }

  get items() { return this.lists[this.current.id] || []; }

  get selected() { return this.items[this.sel[this.current.id]] || null; }

  load(force = false) {
    const tab = this.current;
    if (!force && this.lists[tab.id]) return;
    this.ui.message = `loading ${tab.label.toLowerCase()}…`;
    this.ui.render();
    const res = tab.load(this.ui.cwd);
    this.errors[tab.id] = res.error ? explain(res.error, res.missing) : null;
    this.lists[tab.id] = res.data || [];
    this.sel[tab.id] = Math.min(this.sel[tab.id], Math.max(0, this.lists[tab.id].length - 1));
    this.ui.message = '';
  }

  // --- drawing ------------------------------------------------------------------

  rowText(item) {
    const { ui } = theme.current();
    const R = ansi.reset();
    const muted = ansi.fg(ui.muted);
    const id = this.current.id;
    if (id === 'prs') {
      const c = gh.checks(item.statusCheckRollup);
      const badge = gh.checksBadge(c);
      const color = c.state === 'failing' ? ui.err : c.state === 'pending' ? ui.warn : ui.ok;
      return {
        left: `#${item.number}`,
        badge: badge ? `${ansi.fg(color)}${badge}${R}` : '',
        badgeW: textWidth(badge),
        title: `${item.isDraft ? '[draft] ' : ''}${item.title}`,
        meta: `${muted}${item.headRefName} · ${item.author ? item.author.login : ''} · ${ago(Date.parse(item.updatedAt))}${R}`,
      };
    }
    if (id === 'issues') {
      const labels = (item.labels || []).map((l) => l.name).join(', ');
      const comments = (item.comments || []).length;
      return {
        left: `#${item.number}`,
        badge: '',
        badgeW: 0,
        title: item.title,
        meta: `${muted}${labels ? `${labels} · ` : ''}${comments ? `${comments} comment${comments === 1 ? '' : 's'} · ` : ''}${ago(Date.parse(item.updatedAt))}${R}`,
      };
    }
    const b = gh.runBadge(item);
    const color = b === '✓' ? ui.ok : b === '✗' ? ui.err : b === '●' ? ui.warn : ui.muted;
    return {
      left: `${ansi.fg(color)}${b}${R}`,
      badge: '',
      badgeW: 0,
      title: `${item.workflowName}: ${item.displayTitle}`,
      meta: `${muted}${item.headBranch} · ${item.event} · ${ago(Date.parse(item.createdAt))}${R}`,
    };
  }

  render() {
    const ui = this.ui;
    const cols = ui.termCols;
    const { ui: colors } = theme.current();
    const R = ansi.reset();
    const repo = ui.github && ui.github.repo;
    const pr = ui.github && ui.github.pr;
    const left = `  GitHub · ${repo ? `${repo.name}${repo.isPrivate ? ' (private)' : ''}` : 'no repository'}`;
    const right = `${ui.status.branch || ''}: ${pr ? `PR #${pr.number}` : 'no PR'}  `;
    let s = `\x1b[H${ui.bar(left + ' '.repeat(Math.max(1, cols - textWidth(left) - textWidth(right))) + right)}`;

    // Tabs, the active one in the selection colours.
    let tabs = ' ';
    TABS.forEach((t, i) => {
      const count = this.lists[t.id] ? ` (${this.lists[t.id].length})` : '';
      const label = ` ${t.label}${count} `;
      tabs += i === this.tab
        ? `${ansi.sgr(`48;5;${colors.select.bg}`)}${ansi.fg(colors.select.fg)}${label}${R} `
        : `${ansi.fg(colors.muted)}${label}${R} `;
    });
    s += `\r\n${tabs}\x1b[K\r\n${ansi.fg(colors.muted)}${'─'.repeat(cols)}${R}`;

    const listH = Math.max(1, ui.termRows - 5);
    const id = this.current.id;
    const items = this.items;
    if (this.sel[id] < this.top[id]) this.top[id] = this.sel[id];
    if (this.sel[id] >= this.top[id] + listH) this.top[id] = this.sel[id] - listH + 1;

    for (let i = 0; i < listH; i++) {
      s += '\r\n';
      const item = items[this.top[id] + i];
      if (!item) {
        if (i === 0 && this.errors[id]) s += `  ${ansi.fg(colors.err)}${fit(this.errors[id], cols - 4)}${R}`;
        else if (i === 0 && this.lists[id]) s += `  ${ansi.fg(colors.muted)}${this.current.empty}${R}`;
        s += '\x1b[K';
        continue;
      }
      const r = this.rowText(item);
      const selected = this.top[id] + i === this.sel[id];
      const leftW = 6;
      const metaPlain = ansi.strip(r.meta);
      const metaW = Math.min(textWidth(metaPlain), Math.floor(cols * 0.4));
      const titleW = Math.max(8, cols - 1 - leftW - (r.badgeW ? r.badgeW + 2 : 0) - metaW - 3);
      const pad = ' '.repeat(Math.max(1, leftW - textWidth(ansi.strip(r.left))));
      const badge = r.badge ? `${r.badge}  ` : '';
      const title = fit(r.title, titleW);
      const meta = fit(metaPlain, metaW);
      if (selected) {
        const plain = `›${ansi.strip(r.left)}${pad}${ansi.strip(badge)}${title}  ${meta}`;
        s += `${ansi.sgr(`48;5;${colors.select.bg}`)}${ansi.fg(colors.select.fg)}${fit(plain, cols)}${R}`;
      } else {
        s += ` ${r.left}${pad}${badge}${title}  ${ansi.fg(colors.muted)}${meta}${R}\x1b[K`;
      }
    }

    s += `\r\n${ui.mode === 'prompt' ? ui.bar(` ${ui.prompt.label}${ui.prompt.value}`) : `${ansi.fg(colors.warn)}${fit(ui.message, cols)}${R}`}`;
    s += `\r\n${ansi.fg(colors.muted)}${fit(KEYS, cols)}${R}`;
    if (ui.mode === 'prompt') s += `\x1b[${ui.termRows - 1};${ui.prompt.label.length + ui.prompt.value.length + 2}H`;
    ui.output.write(s);
  }

  // --- actions ----------------------------------------------------------------------

  details() {
    const item = this.selected;
    if (!item) return;
    const id = this.current.id;
    this.ui.message = 'loading…';
    this.ui.render();
    let res;
    let title;
    if (id === 'prs') { res = gh.prDetails(this.ui.cwd, item.number); title = `pull request #${item.number}`; }
    else if (id === 'issues') { res = gh.issueDetails(this.ui.cwd, item.number); title = `issue #${item.number}`; }
    else { res = gh.runDetails(this.ui.cwd, item.databaseId); title = `run ${item.databaseId}`; }
    this.ui.message = '';
    if (res.error) { this.ui.message = explain(res.error); return; }
    this.ui.showOutput(title, res.data.join('\n'));
  }

  openSelected() {
    const item = this.selected;
    const url = item ? item.url : this.ui.github && this.ui.github.repo && this.ui.github.repo.url;
    if (!url) return;
    this.ui.message = gh.openInBrowser(url) ? `opened ${url}` : 'could not open a browser';
  }

  checkout() {
    const item = this.selected;
    if (this.current.id !== 'prs' || !item) return;
    const dirty = this.ui.status.staged.length + this.ui.status.unstaged.length;
    const warn = dirty ? ' You have uncommitted changes.' : '';
    this.ui.askPrompt(`Check out #${item.number} (${item.headRefName})?${warn} (y/n) `, '', (v) => {
      if (!/^y(es)?$/i.test(v.trim())) { this.ui.message = 'left the branch alone'; return; }
      const res = gh.checkoutPR(this.ui.cwd, item.number);
      this.ui.message = res.error ? explain(res.error) : `now on ${item.headRefName}`;
      this.ui.refresh();
      this.ui.refreshGitHub(true);
    });
  }

  merge() {
    const item = this.selected;
    if (this.current.id !== 'prs' || !item) return;
    const c = gh.checks(item.statusCheckRollup);
    const note = c.state === 'failing' ? ' Checks are failing!' : c.state === 'pending' ? ' Checks are still running.' : '';
    // Merging changes the shared repository, so it takes a typed word.
    this.ui.askPrompt(`Squash-merge #${item.number} into ${item.baseRefName} and delete its branch?${note} Type merge: `, '', (v) => {
      if (v.trim().toLowerCase() !== 'merge') { this.ui.message = 'not merged'; return; }
      this.ui.message = `merging #${item.number}…`;
      this.ui.render();
      const res = gh.mergePR(this.ui.cwd, item.number);
      // Reload first: loading resets the message line.
      this.load(true);
      this.ui.refreshGitHub(true);
      this.ui.message = res.error ? explain(res.error) : `merged #${item.number}`;
    });
  }

  create() {
    if (this.current.id === 'prs') { this.ui.createPullRequest(() => this.load(true)); return; }
    if (this.current.id !== 'issues') return;
    this.ui.askPrompt('New issue title: ', '', (title) => {
      if (!title.trim()) { this.ui.message = 'cancelled'; return; }
      const res = gh.createIssue(this.ui.cwd, { title: title.trim() });
      this.load(true);
      this.ui.message = res.error ? explain(res.error) : `created ${res.data.url}`;
    });
  }

  // Returns true when the view should close.
  handleKey(key) {
    const id = this.current.id;
    const move = (d) => { this.sel[id] = Math.max(0, Math.min(this.items.length - 1, this.sel[id] + d)); };
    const switchTab = (d) => { this.tab = (this.tab + d + TABS.length) % TABS.length; this.load(); };
    if (key.name === 'escape' || key.str === 'q' || key.str === 'G') return true;
    if (key.name === 'right' || key.str === ']' || (key.name === 'tab' && !key.shift)) switchTab(1);
    else if (key.name === 'left' || key.str === '[' || (key.name === 'tab' && key.shift)) switchTab(-1);
    else if (key.name === 'up' || key.str === 'k') move(-1);
    else if (key.name === 'down' || key.str === 'j') move(1);
    else if (key.name === 'return') this.details();
    else if (key.str === 'o') this.openSelected();
    else if (key.str === 'r') { this.load(true); this.ui.refreshGitHub(true); this.ui.message = 'reloaded'; }
    else if (key.str === 'n') this.create();
    else if (key.str === 'c') this.checkout();
    else if (key.str === 'm') this.merge();
    return false;
  }
}

// Turns gh's errors into something actionable.
function explain(error, missing) {
  if (missing || /not installed/.test(error)) return 'the GitHub CLI is not installed — brew install gh';
  if (/auth login|not logged in|authentication/i.test(error)) return 'not signed in to GitHub — run: gh auth login';
  if (/no git remotes|not a git repository|none of the git remotes/i.test(error)) return 'this repository has no GitHub remote';
  return error.split('\n')[0];
}

module.exports = { GitHubView, TABS, explain };
