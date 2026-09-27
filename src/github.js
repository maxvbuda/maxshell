'use strict';

const { spawnSync, spawn } = require('child_process');

// GitHub through the `gh` CLI, which handles login. Every call goes through
// a runner that tests can replace with canned output.

function defaultRunner(cwd, args, { timeout = 15000 } = {}) {
  let res;
  try {
    res = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, stdout: '', stderr: e.message };
  }
  if (res.error) {
    const missing = res.error.code === 'ENOENT';
    return { ok: false, stdout: '', stderr: missing ? 'the GitHub CLI (gh) is not installed' : res.error.message, missing };
  }
  return { ok: res.status === 0, stdout: res.stdout || '', stderr: (res.stderr || '').trim() };
}

let runner = defaultRunner;
function setRunner(fn) { runner = fn || defaultRunner; }

function json(cwd, args, opts) {
  const res = runner(cwd, args, opts);
  if (!res.ok) return { error: res.stderr || 'gh failed', missing: !!res.missing };
  try {
    return { data: JSON.parse(res.stdout || 'null') };
  } catch {
    return { error: 'unexpected output from gh' };
  }
}

// --- summaries ----------------------------------------------------------------------

// Collapses a statusCheckRollup into counts and one overall state.
function checks(rollup) {
  const out = { passed: 0, failed: 0, pending: 0, total: 0 };
  for (const c of rollup || []) {
    const state = (c.conclusion || c.state || c.status || '').toUpperCase();
    out.total++;
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state)) out.passed++;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state)) out.failed++;
    else out.pending++;
  }
  out.state = out.total === 0 ? 'none' : out.failed ? 'failing' : out.pending ? 'pending' : 'passing';
  return out;
}

function checksBadge(c) {
  if (!c || c.state === 'none') return '';
  if (c.state === 'failing') return `✗ ${c.failed}/${c.total}`;
  if (c.state === 'pending') return `● ${c.pending} running`;
  return `✓ ${c.passed}`;
}

function runBadge(run) {
  if (run.status !== 'completed') return '●';
  return run.conclusion === 'success' ? '✓' : ['skipped', 'neutral'].includes(run.conclusion) ? '–' : '✗';
}

// --- reads ------------------------------------------------------------------------

function repo(cwd) {
  const r = json(cwd, ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef,isPrivate'], { timeout: 8000 });
  if (r.error) return r;
  return {
    data: {
      name: r.data.nameWithOwner,
      url: r.data.url,
      defaultBranch: r.data.defaultBranchRef && r.data.defaultBranchRef.name,
      isPrivate: r.data.isPrivate,
    },
  };
}

const PR_FIELDS = 'number,title,state,isDraft,url,author,headRefName,baseRefName,updatedAt,reviewDecision,statusCheckRollup';

// The pull request for the current branch, or data: null if there isn't one.
function branchPR(cwd) {
  const res = runner(cwd, ['pr', 'view', '--json', PR_FIELDS], { timeout: 8000 });
  if (!res.ok) {
    if (/no pull requests? found/i.test(res.stderr)) return { data: null };
    return { error: res.stderr || 'gh failed' };
  }
  try { return { data: JSON.parse(res.stdout) }; } catch { return { error: 'unexpected output from gh' }; }
}

function listPRs(cwd) {
  return json(cwd, ['pr', 'list', '--limit', '30', '--json', PR_FIELDS]);
}

function listIssues(cwd) {
  return json(cwd, ['issue', 'list', '--limit', '30', '--json', 'number,title,state,url,author,labels,comments,updatedAt']);
}

function listRuns(cwd) {
  return json(cwd, ['run', 'list', '--limit', '20', '--json',
    'databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url']);
}

// Readable details for the pager.
function prDetails(cwd, number) {
  const r = json(cwd, ['pr', 'view', String(number), '--json',
    `${PR_FIELDS},body,additions,deletions,changedFiles,comments,reviews`]);
  if (r.error) return r;
  const p = r.data;
  const c = checks(p.statusCheckRollup);
  const lines = [
    `#${p.number}  ${p.title}`,
    `${p.isDraft ? 'draft · ' : ''}${p.state.toLowerCase()} · ${p.author && p.author.login} wants to merge ${p.headRefName} into ${p.baseRefName}`,
    `+${p.additions} −${p.deletions} in ${p.changedFiles} file${p.changedFiles === 1 ? '' : 's'}${p.reviewDecision ? ` · review: ${p.reviewDecision.toLowerCase().replace(/_/g, ' ')}` : ''}`,
    `checks: ${checksBadge(c) || 'none'}`,
    p.url,
    '',
    ...(p.body ? p.body.split('\n') : ['(no description)']),
  ];
  for (const check of p.statusCheckRollup || []) {
    if (lines[lines.length - 1] !== '' && !lines.includes('── checks ──')) lines.push('', '── checks ──');
    const state = (check.conclusion || check.state || check.status || '').toLowerCase();
    lines.push(`  ${state.padEnd(10)} ${check.name || check.context || ''}`);
  }
  for (const cm of p.comments || []) {
    lines.push('', `── ${cm.author && cm.author.login} ──`, ...String(cm.body || '').split('\n'));
  }
  return { data: lines };
}

function issueDetails(cwd, number) {
  const r = json(cwd, ['issue', 'view', String(number), '--json', 'number,title,state,url,author,labels,body,comments']);
  if (r.error) return r;
  const i = r.data;
  const labels = (i.labels || []).map((l) => l.name).join(', ');
  const lines = [
    `#${i.number}  ${i.title}`,
    `${i.state.toLowerCase()} · opened by ${i.author && i.author.login}${labels ? ` · ${labels}` : ''}`,
    i.url,
    '',
    ...(i.body ? i.body.split('\n') : ['(no description)']),
  ];
  for (const cm of i.comments || []) {
    lines.push('', `── ${cm.author && cm.author.login} ──`, ...String(cm.body || '').split('\n'));
  }
  return { data: lines };
}

function runDetails(cwd, id) {
  const res = runner(cwd, ['run', 'view', String(id)]);
  if (!res.ok) return { error: res.stderr || 'gh failed' };
  return { data: res.stdout.replace(/\n$/, '').split('\n') };
}

// --- writes -------------------------------------------------------------------------

function createPR(cwd, { title, body = '', base }) {
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (base) args.push('--base', base);
  const res = runner(cwd, args, { timeout: 30000 });
  if (!res.ok) return { error: res.stderr || 'could not create the pull request' };
  return { data: { url: res.stdout.trim().split('\n').pop() } };
}

function createIssue(cwd, { title, body = '' }) {
  const res = runner(cwd, ['issue', 'create', '--title', title, '--body', body], { timeout: 30000 });
  if (!res.ok) return { error: res.stderr || 'could not create the issue' };
  return { data: { url: res.stdout.trim().split('\n').pop() } };
}

function checkoutPR(cwd, number) {
  const res = runner(cwd, ['pr', 'checkout', String(number)], { timeout: 60000 });
  return res.ok ? { data: true } : { error: res.stderr || 'checkout failed' };
}

function mergePR(cwd, number) {
  const res = runner(cwd, ['pr', 'merge', String(number), '--squash', '--delete-branch'], { timeout: 60000 });
  return res.ok ? { data: true } : { error: res.stderr || 'merge failed' };
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  setRunner, defaultRunner, checks, checksBadge, runBadge,
  repo, branchPR, listPRs, listIssues, listRuns, prDetails, issueDetails, runDetails,
  createPR, createIssue, checkoutPR, mergePR, openInBrowser,
};
