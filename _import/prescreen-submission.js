#!/usr/bin/env node
/**
 * DeepGuard submission pre-screening script (pure script, no AI involved)
 *
 * Mechanically pre-screens community-submitted (or locally specified) plugin repos; qualified
 * submissions enter the local audit queue _import/audit-queue/<id>.json and wait for the audit
 * agent to make the final in-session admission decision.
 *
 * Pre-screening items (all deterministic checks):
 *   0. Submitter eligibility (only with --submitter): whitelist → identity (submitter == repo
 *      owner) → account age → blacklist — the same rules as agent/scripts/intake-gate.mjs,
 *      evaluated at submission time so ineligible submitters are rejected BEFORE enqueue/dispatch
 *      (the audit-side intake-gate re-runs them authoritatively)
 *   1. URL normalization (must be a GitHub repo root; subpaths/.git are stripped and recorded)
 *   2. Deduplication: already admitted under reports/, already collected in catalog.json,
 *      pending/auditing entries in the queue
 *   3. Repo reachability: GitHub API (exists/public/archived/default branch/last push/stars)
 *   4. Shallow clone to pin the HEAD commit; read package.json: version, dsh declaration shape,
 *      engines
 *
 * Usage:
 *   node _import/prescreen-submission.js --url https://github.com/owner/repo [--category ui] [--note "..."] [--submitter <login>]
 *   node _import/prescreen-submission.js --issue-file issue.md --submitter <login>   # parse an exported Issue Form body
 *   node _import/prescreen-submission.js --list                  # show the queue
 *   node _import/prescreen-submission.js --mark <id> <pending|auditing|audited|rejected> [--reason "..."]
 *
 * Node.js built-in modules only; no third-party dependencies.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');
const CATALOG = path.join(__dirname, 'catalog.json');
const QUEUE = path.join(__dirname, 'audit-queue');
const WHITELIST = path.join(__dirname, 'whitelist.json');
const BLACKLIST = path.join(REPORTS, '_blacklist.json');
const CLONE_BASE = path.join(os.tmpdir(), 'deepguard-prescreen');

const MIN_ACCOUNT_AGE_DAYS = 10; // same threshold as agent/scripts/intake-gate.mjs

const CATS = ['ui', 'tools', 'sandbox', 'bridge', 'model', 'memory', 'workflow'];
const CAT_ALIASES = {
  'UI Extension (ui)': 'ui', 'Tools (tools)': 'tools', 'Sandbox / Execution (sandbox)': 'sandbox',
  'Bridge (bridge)': 'bridge', 'Model Adapter (model)': 'model', 'Memory (memory)': 'memory',
  'Workflow (workflow)': 'workflow',
  // legacy labels (compatible with old issues) — keys are matched verbatim against
  // issue-form content; do NOT translate
  'Workflow / Memory (memory)': 'memory',
  'ui 扩展（ui）': 'ui', '工具（tools）': 'tools', '沙箱/执行（sandbox）': 'sandbox',
  '桥接（bridge）': 'bridge', '模型适配（model）': 'model', '工作流/记忆（memory）': 'memory'
};
const STATUSES = ['pending', 'auditing', 'audited', 'rejected'];

/* ---------- helpers ---------- */
function readJSON(fp) { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
function writeJSON(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function nowISO() { return new Date().toISOString(); }
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-'); }

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else args._.push(argv[i]);
  }
  return args;
}

/* ---------- URL normalization ---------- */
function normalizeRepoUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return { ok: false, reason: 'repository URL is empty' };
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');
  const m = u.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/);
  if (!m) return { ok: false, reason: `not a valid GitHub repository URL: ${raw}` };
  const sub = m[3] ? m[3].replace(/^\/(tree|blob)\/[^/]+/, '').replace(/^\/+|\/+$/g, '') : '';
  /* GitHub owner/repo names are case-insensitive: fold to lowercase so url/repo double as canonical
     dedup keys — a case-variant resubmission (github.com/Owner/Repo vs github.com/owner/repo) must
     hit the same catalog/queue entry instead of slipping past the exact-match dedup. */
  const owner = m[1].toLowerCase();
  const repo = m[2].toLowerCase();
  return {
    ok: true,
    owner, repo,
    url: `https://github.com/${owner}/${repo}`,
    subpath: sub || null   // user pasted a subpath: record it; source.url still pins the repo root
  };
}

/* Monorepo submissions put the subpath in the additional notes (the issue form itself
   instructs: "put the subpath in the additional notes"). Recognize a note line like:
   - Monorepo subpath: `examples/dsh-plugin` (audit focus; ...)   */
function parseSubpathFromNote(note) {
  const m = String(note || '').match(/monorepo subpath:\s*`?([^`\s)]+)`?/i);
  return m ? m[1].replace(/\/+$/, '') : null;
}

/* Same acceptance rule as agent/scripts/prepare.mjs: relative path, no ".." segments. */
function validSubpath(sub) {
  return !!sub && !sub.startsWith('/') && !sub.split('/').includes('..') && !sub.split('/').some(s => !s);
}

/* T-14 (SUS-02): the queue-entry name flows verbatim into the Sonar/Aegis task cards, so blacklist
   the prompt/markup injection carriers (< > " ' $ `, newlines, control chars) and cap the length.
   Blacklist, NOT whitelist — existing names legitimately contain '#', '/', and spaces
   (e.g. "OpenViking#examples/dsh-memory-plugin", "DSH Mermaid"); a whitelist would reject them. */
function validPluginName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 120) return false;
  return !/[<>"'$`\x00-\x1f\x7f]/.test(name);
}

/* ---------- Issue Form body parsing (### heading\n\ncontent paragraph structure) ----------
   NOTE: the Chinese field-name keys below match headings of legacy bilingual issue forms
   verbatim — do NOT translate. */
function parseIssueBody(text) {
  const fields = {};
  const re = /###\s+([^\n]+)\n+([\s\S]*?)(?=\n###\s+|$)/g;
  let m;
  while ((m = re.exec(text))) fields[m[1].trim()] = m[2].trim();
  const checks = {};
  const cre = /-\s*\[([ xX])\]\s*([^\n]+)/g;
  while ((m = cre.exec(text))) checks[m[2].trim()] = m[1].toLowerCase() === 'x';
  const catRaw = fields['Plugin Category'] || fields['插件分类'] || '';
  return {
    name: (fields['Plugin Name'] || fields['插件名称'] || '').replace(/^_No response_$/i, ''),
    url: fields['Repository URL'] || fields['仓库地址'] || '',
    category: CAT_ALIASES[catRaw] || null,
    note: (fields['Additional Notes'] || fields['补充说明'] || '').replace(/^_No response_$/i, ''),
    confirmations: checks
  };
}

/* ---------- deduplication ---------- */
function collectKnownRepos() {
  /* Keys are folded to lowercase at insertion: stored urls may be legacy mixed-case (published
     reports are immutable artifacts and are not migrated), while the lookup side (norm.url) is
     canonical lowercase — folding both sides keeps dedup correct regardless of stored case. */
  const repos = new Map();  // canonical lowercase url -> { in, id }
  const ids = new Set();
  if (fs.existsSync(REPORTS)) {
    for (const id of fs.readdirSync(REPORTS)) {
      const dir = path.join(REPORTS, id);
      if (id.startsWith('_') || !fs.statSync(dir).isDirectory()) continue;
      ids.add(id);
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const n of fs.readdirSync(d)) {
          const fp = path.join(d, n);
          const st = fs.statSync(fp);
          if (st.isDirectory()) { stack.push(fp); continue; }
          if (!n.endsWith('.json') || n.startsWith('_')) continue;
          try {
            const url = readJSON(fp).plugin && readJSON(fp).plugin.source && readJSON(fp).plugin.source.url;
            if (url && !repos.has(url.toLowerCase())) repos.set(url.toLowerCase(), { in: 'reports', id });
          } catch { /* a corrupt report does not block pre-screening */ }
        }
      }
    }
  }
  if (fs.existsSync(CATALOG)) {
    const cat = readJSON(CATALOG);
    const list = Array.isArray(cat) ? cat : (cat.plugins || []);
    for (const p of list) {
      if (p.url && !repos.has(p.url.toLowerCase())) repos.set(p.url.toLowerCase(), { in: 'catalog', id: p.id });
    }
  }
  return { repos, ids };
}

function queueEntries() {
  if (!fs.existsSync(QUEUE)) return [];
  return fs.readdirSync(QUEUE).filter(n => n.endsWith('.json')).map(n => ({ file: path.join(QUEUE, n), data: readJSON(path.join(QUEUE, n)) }));
}

/* ---------- GitHub API ---------- */
/* token resolution: GITHUB_TOKEN env first, local fallback to gh CLI auth (anonymous quota is only 60 req/hour) */
function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

async function ghRepo(owner, repo) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'deepguard-prescreen', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = resolveToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (res.status === 404) return { ok: false, reason: 'repository does not exist or is not public (HTTP 404)' };
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') return { ok: false, reason: 'GitHub API quota exhausted (set GITHUB_TOKEN or sign in via gh CLI)' };
  if (!res.ok) return { ok: false, reason: `GitHub API HTTP ${res.status}` };
  const d = await res.json();
  return {
    ok: true,
    default_branch: d.default_branch,
    pushed_at: d.pushed_at,
    stars: d.stargazers_count,
    archived: !!d.archived,
    description: d.description || ''
  };
}

async function ghUser(login) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'deepguard-prescreen', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = resolveToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers });
  if (!res.ok) return { ok: false, status: res.status };
  const d = await res.json();
  return { ok: true, created_at: d.created_at, id: d.id ?? null };
}

/* T-07: soft repo-facts fetch for blacklist id-pinning — a failure must NEVER block eligibility
   (degrades to login comparison; the audit-side intake-gate re-checks authoritatively). */
async function ghRepoIds(repoFull) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'deepguard-prescreen', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = resolveToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFull}`, { headers });
    if (!res.ok) return { repo_id: null, owner_id: null };
    const d = await res.json();
    return { repo_id: d.id ?? null, owner_id: d.owner?.id ?? null };
  } catch { return { repo_id: null, owner_id: null }; }
}

/* ---------- submitter eligibility gate ----------
   Same decision order and reason strings as agent/scripts/intake-gate.mjs
   (whitelist → identity → account age → blacklist). Runs at submission time so ineligible
   submitters are rejected before enqueue/dispatch; the audit-side intake-gate re-runs the
   same checks authoritatively (manual dispatch / direct queue edits bypass this script). */
async function checkSubmitterEligibility(submitter, owner, repoFull) {
  /* 1. whitelist (active only; exempts identity + account age, never blacklist) */
  const whitelist = fs.existsSync(WHITELIST) ? readJSON(WHITELIST) : { users: [] };
  const whitelisted = (whitelist.users || []).some(u => u.login === submitter && u.status === 'active');

  /* 2. identity: only the plugin author may submit — submitter == repo owner (server-side fact) */
  if (!whitelisted && submitter.toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, reason: `not-author: @${submitter} is not the plugin author (repository owner @${owner}); only the plugin author may submit` };
  }

  /* 3. account age — the profile is fetched once; the immutable user id is reused by the
        blacklist check below (T-07 id-pinning) */
  let submitterGid = null;
  if (!whitelisted) {
    const u = await ghUser(submitter);
    if (!u.ok) return { ok: false, reason: `cannot read submitter profile: HTTP ${u.status}` };
    submitterGid = u.id ?? null;
    const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 86_400_000;
    if (ageDays < MIN_ACCOUNT_AGE_DAYS) {
      return { ok: false, reason: `account-too-new (registered ${Math.floor(ageDays)} days < ${MIN_ACCOUNT_AGE_DAYS} days)` };
    }
  }

  /* 4. blacklist (checked even for whitelisted; checks repo / owner / org / submitter)
     T-07 id-pinning: entries may carry immutable GitHub ids (repo_id/user_id/org_id); the login is
     display-only. When both sides carry an id, the id decides (a renamed repo/account stays
     blacklisted; a squatter re-registering the login is NOT hit); otherwise exact-login fallback.
     Same rule as intake-gate.mjs. */
  const blacklist = fs.existsSync(BLACKLIST) ? readJSON(BLACKLIST) : { entries: [] };
  const active = (blacklist.entries || []).filter(e => e.status === 'active');
  const entryGid = e => e.repo_id ?? e.user_id ?? e.org_id ?? null;
  const matches = (e, gid, login) => {
    const eg = entryGid(e);
    return eg != null && gid != null ? eg === gid : String(e.name).toLowerCase() === String(login).toLowerCase();
  };
  let repoGid = null, ownerGid = null;
  if (active.some(e => entryGid(e) != null)) {
    const ids = await ghRepoIds(repoFull);
    repoGid = ids.repo_id;
    ownerGid = ids.owner_id;
    if (submitterGid == null) { // whitelisted path skipped the profile fetch — fetch it for the id only
      const u = await ghUser(submitter);
      if (u.ok) submitterGid = u.id ?? null;
    }
  }
  const hit = active.find(e => e.type === 'repo' && matches(e, repoGid, repoFull))
    || active.find(e => (e.type === 'user' || e.type === 'org') && matches(e, ownerGid, owner))
    || active.find(e => e.type === 'user' && matches(e, submitterGid, submitter));
  if (hit) return { ok: false, reason: `blacklisted:${hit.id} (${hit.type} ${hit.name} — ${hit.reason})` };

  return { ok: true, whitelisted };
}

/* ---------- shallow clone + manifest ---------- */
function cloneAndInspect(url, subpath) {
  fs.mkdirSync(CLONE_BASE, { recursive: true });
  const dest = path.join(CLONE_BASE, url.replace(/^https:\/\/github\.com\//, '').replace('/', '__'));
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    execFileSync('git', ['clone', '--depth', '1', '--quiet', url, dest], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (e) {
    return { ok: false, reason: `clone failed: ${String(e.stderr || e.message).split('\n')[0]}` };
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: dest }).trim();
  /* Monorepo fix (Harbor triplet-mismatch veto on dsh-web-ui): the queue-locked version/name/hooks
   * must come from the SAME manifest the audit reads — prepare.mjs trims the audit root to
   * queue.subpath and reads <subpath>/package.json (declared e.g. 0.2.8), while prescreen used to
   * read the monorepo ROOT package.json (workspace version 0.1.1) → queue/report triplet mismatch
   * → Harbor fail-closed veto. Read the subpath manifest first; fall back to root with a warning. */
  const subPkgPath = subpath ? path.join(dest, subpath, 'package.json') : null;
  const rootPkgPath = path.join(dest, 'package.json');
  let pkgPath = null; let fellBack = false;
  if (subPkgPath && fs.existsSync(subPkgPath)) pkgPath = subPkgPath;
  else if (fs.existsSync(rootPkgPath)) { pkgPath = rootPkgPath; fellBack = !!subpath; }
  if (!pkgPath) return { ok: true, commit, manifest: null, warning: `no package.json at ${subpath ? `subpath ${subpath} or the repo root` : 'the repo root'} (non-standard npm package layout; audit scope needs human confirmation)` };
  const pkg = readJSON(pkgPath);
  const dsh = pkg.dsh || {};
  const kinds = ['bundle', 'client', 'service'].filter(k => dsh[k]);
  return {
    ok: true, commit,
    manifest: {
      name: pkg.name || null,
      version: pkg.version || null,
      dsh_kind: kinds,
      engines: (pkg.engines && pkg.engines.dsh) || null,
      install_hooks: ['preinstall', 'install', 'postinstall', 'prepare'].filter(h => pkg.scripts && pkg.scripts[h])
    },
    warning: (fellBack ? `subpath ${subpath} has no package.json; fell back to the repo-root manifest (version/name may describe the workspace, not the plugin — triplet mismatch risk at the mirror gate). ` : '')
      + (kinds.length ? '' : 'package.json has no dsh.bundle/client/service declaration (will be audited as a plain package by actual code behavior)') || null
  };
}

/* ---------- id generation (owner-qualified, 2026-08-23) ----------
 * Queue id = `${slugify(owner)}--${slugify(repo)}` — the queue file stem, report dir, artifact
 * suffix, and PR/branch token are all derived from this one identity, so same-name repos
 * (omdsh-dev/dsh_workflow vs icetomoyo/dsh_workflow, both slugify to "dsh-workflow") no longer
 * collide or get silently renamed at intake. "--" is unambiguous: GitHub usernames disallow
 * consecutive hyphens, so owner never contains "--" (split at the FIRST "--" recovers owner/repo).
 * The id charset gates (workflow input + intake-gate + prepare: ^[a-z0-9][a-z0-9-]*$) accept this
 * unchanged. Entries admitted before this change keep their legacy short ids (grandfathered —
 * published report URLs must not churn); dup detection is repo-URL-based, so a legacy-id repo
 * re-submitted as an issue is still caught, and tripleIds already re-checks the legacy id.
 * Slugify degradation (CJK repo names strip to "") falls back to the legacy dance. */
function pickId(repo, owner, takenIds) {
  const rs = slugify(repo), os = slugify(owner);
  if (rs && os) {
    const qualified = `${os}--${rs}`;
    if (!takenIds.has(qualified)) return qualified;
    let i = 2;
    while (takenIds.has(`${qualified}-${i}`)) i++;
    return `${qualified}-${i}`;
  }
  const base = rs || os;
  let i = 2;
  while (takenIds.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/* ---------- task card output ---------- */
function printCard(e) {
  const p = e.prescreen;
  console.log('\n--- pre-screening task card (can be pasted back to the issue) ---\n');
  console.log(p.ok ? '**Pre-screening passed** ✅' : `**Pre-screening failed** ❌ (${p.fail_reason})`);
  console.log(`- Plugin: ${e.name} (\`${e.id}\`)`);
  if (p.ok) {
    console.log(`- Repo: ${e.repo} @ \`${p.commit.slice(0, 8)}\` (default branch ${p.default_branch}, last push ${String(p.pushed_at).slice(0, 10)}, ★ ${p.stars})`);
    console.log(`- Shape: ${p.dsh_kind.length ? p.dsh_kind.map(k => `dsh.${k}`).join(' + ') : 'no dsh declaration'}, version ${p.version || 'undeclared'}`);
    if (p.install_hooks.length) console.log(`- Install hooks: ${p.install_hooks.join(', ')} (audit focus: DS08)`);
    console.log(`- Dedup: ${p.dup ? `hit ${p.dup.in} (${p.dup.id})` : 'no conflict'}`);
    for (const w of p.warnings) console.log(`- ⚠ ${w}`);
    console.log(`- Queue status: ${e.status}`);
  }
  console.log('');
}

/* ---------- subcommands ---------- */
async function cmdSubmit(input) {
  const norm = normalizeRepoUrl(input.url);
  if (!norm.ok) { console.error(`✗ ${norm.reason}`); process.exit(1); }

  const warnings = [];
  if (norm.subpath) warnings.push(`submitted URL contains subpath ${norm.subpath}; source.url pins the repo root — put the subpath in the additional notes`);

  /* Monorepo audit scope: URL-pasted subpath wins; otherwise recover it from the notes
     (batch tooling writes "- Monorepo subpath: ..." there). prepare.mjs trims the audit
     root to queue.subpath — without this field the WHOLE repo enters scope and the
     link-entry guard can reject unrelated parts of the monorepo. */
  const subpath = norm.subpath || parseSubpathFromNote(input.note);
  if ((norm.subpath || /monorepo subpath/i.test(input.note || '')) && !validSubpath(subpath)) {
    console.error(`✗ invalid monorepo subpath: ${subpath || '(found in notes but unparseable)'}`);
    process.exit(1);
  }

  /* Submitter eligibility gate (fail fast: ineligible submissions are rejected before any
     dedup/reachability work, before enqueue, and before the audit pipeline is dispatched).
     Only runs when a submitter is known — the issue-intake workflow always passes the issue
     author via --submitter; bare local CLI runs skip it (the audit-side intake-gate still
     re-checks authoritatively). */
  if (input.submitter) {
    const elig = await checkSubmitterEligibility(input.submitter, norm.owner, norm.url.replace(/^https:\/\/github\.com\//, ''));
    if (!elig.ok) { console.error(`✗ ${elig.reason}`); process.exit(1); }
    if (elig.whitelisted) console.log(`ℹ submitter @${input.submitter} is whitelisted (identity/account-age exempt)`);
  }

  const { repos: known, ids: takenIds } = collectKnownRepos();
  const dup = known.get(norm.url) || null;
  // stored queue urls may be legacy mixed-case (pre-migration); norm.url is canonical lowercase — fold the stored side
  const queueDup = queueEntries().find(q => String(q.data.url || '').toLowerCase() === norm.url && ['pending', 'auditing'].includes(q.data.status));
  if (queueDup) { console.error(`✗ the queue already has a ${queueDup.data.status === 'pending' ? 'pending' : 'auditing'} entry for this repo: ${queueDup.data.id}`); process.exit(1); }

  const gh = await ghRepo(norm.owner, norm.repo);
  if (!gh.ok) { console.error(`✗ ${gh.reason}`); process.exit(1); }
  if (gh.archived) warnings.push('repository is archived');

  const insp = cloneAndInspect(norm.url, subpath);
  if (!insp.ok) { console.error(`✗ ${insp.reason}`); process.exit(1); }
  if (insp.warning) warnings.push(insp.warning);

  const id = pickId(norm.repo, norm.owner, takenIds);
  if (id !== `${slugify(norm.owner)}--${slugify(norm.repo)}`) warnings.push(`owner-qualified id collides with an existing entry; using ${id} instead`);

  // same-triple dedup: if a report already exists for id@version#commit, reject outright
  // (same rule as intake-gate check ⑤; this is the fast-feedback path).
  // Also check the id this repo URL is already admitted under (dup.id): pickId renames on
  // collision, and the rename must not let the identical snapshot bypass dedup under a fresh id.
  const pv = insp.manifest && insp.manifest.version;
  const tripleIds = [id];
  if (dup && dup.in === 'reports' && dup.id && !tripleIds.includes(dup.id)) tripleIds.push(dup.id);
  if (pv && insp.commit) {
    for (const tid of tripleIds) {
      if (fs.existsSync(path.join(REPORTS, tid, pv, `${insp.commit}.json`))) {
        console.error(`✗ Already audited: ${tid}@${pv}#${insp.commit.slice(0, 8)} — this exact version+commit snapshot already has a report. Bump the version or push new commits before re-submitting.`);
        process.exit(1);
      }
    }
  }

  // T-14: validate the final resolved name BEFORE it enters the queue (sources: issue form →
  // package.json → repo slug; the first two are attacker/submitter-controllable)
  const entryName = input.name || (insp.manifest && insp.manifest.name) || norm.repo;
  if (!validPluginName(entryName)) {
    console.error(`✗ Invalid plugin name: blacklisted character or over 120 chars — the name flows verbatim into audit task cards; injection carriers (< > " ' $ \`, newlines, control chars) are refused. Fix the Plugin Name field (or the package.json "name") and re-submit.`);
    process.exit(1);
  }

  const entry = {
    id,
    name: entryName,
    repo: `${norm.owner}/${norm.repo}`,
    url: norm.url,
    subpath: subpath || null,
    category_hint: input.category || null,
    capabilities_hint: input.capabilities || [],
    note: input.note || '',
    source: input.source || 'cli',
    issue: input.issue || null,
    status: 'pending',
    submitted_at: nowISO(),
    prescreen: {
      ok: true,
      commit: insp.commit,
      default_branch: gh.default_branch,
      pushed_at: gh.pushed_at,
      stars: gh.stars,
      version: insp.manifest ? insp.manifest.version : null,
      dsh_kind: insp.manifest ? insp.manifest.dsh_kind : [],
      install_hooks: insp.manifest ? insp.manifest.install_hooks : [],
      dup,
      warnings
    },
    history: [{ at: nowISO(), action: 'prescreen-pass' }]
  };
  writeJSON(path.join(QUEUE, `${id}.json`), entry);
  printCard(entry);
  console.log(`✓ queued: _import/audit-queue/${id}.json`);
  if (dup) console.log(`ℹ note: this repo already exists in ${dup.in} (${dup.id}) — for re-audit/new versions use the version-increment flow`);
}

function cmdList() {
  const list = queueEntries();
  if (!list.length) { console.log('queue is empty'); return; }
  for (const { data: e } of list) {
    const c = e.prescreen && e.prescreen.commit ? e.prescreen.commit.slice(0, 8) : '—';
    console.log(`${e.status.padEnd(9)} ${e.id.padEnd(28)} ${e.repo} @ ${c}  ${e.submitted_at.slice(0, 10)}`);
  }
}

function cmdMark(id, status, reason) {
  if (!STATUSES.includes(status)) { console.error(`✗ invalid status: ${status} (allowed: ${STATUSES.join('/')})`); process.exit(1); }
  const fp = path.join(QUEUE, `${id}.json`);
  if (!fs.existsSync(fp)) { console.error(`✗ no such queue entry: ${id}`); process.exit(1); }
  const e = readJSON(fp);
  e.status = status;
  e.history.push({ at: nowISO(), action: status, reason: reason || null });
  writeJSON(fp, e);
  console.log(`✓ ${id} → ${status}${reason ? ` (${reason})` : ''}`);
}

/* ---------- main entry ---------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return cmdList();
  if (args.mark) return cmdMark(args.mark, args._[0], args.reason);

  let input = null;
  if (args['issue-file']) {
    const parsed = parseIssueBody(fs.readFileSync(args['issue-file'], 'utf8'));
    if (!parsed.url) { console.error('✗ no "仓库地址" (Repository URL) field found in the issue content'); process.exit(1); }
    input = { ...parsed, source: 'issue', submitter: args.submitter || null };
  } else if (args.url) {
    input = {
      url: args.url,
      name: args.name || null,
      category: args.category && CATS.includes(args.category) ? args.category : null,
      note: args.note || '',
      source: 'cli',
      submitter: args.submitter || null
    };
    if (args.category && !input.category) console.warn(`! unknown category ${args.category}, ignored (allowed: ${CATS.join('/')})`);
  } else {
    console.log('usage: --url <repo> | --issue-file <path> | --list | --mark <id> <status>');
    process.exit(1);
  }
  await cmdSubmit(input);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
