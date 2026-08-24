#!/usr/bin/env node
/**
 * DeepGuard plugin collection script
 *
 * Parses a structured plugin catalog from the README.md of the awesome-dsh-plugin repo
 * (the data source behind awesome-dsh-plugin.com), for batch auditing by deepguard-audit.
 *
 * Usage:
 *   node _import/collect-plugins.js                # collect and write _import/catalog.json
 *   node _import/collect-plugins.js --out x.json   # custom output path
 *   node _import/collect-plugins.js --limit 10     # take only the first 10 entries (debugging)
 *
 * Data source priority:
 *   1. gh api (best reachability of api.github.com, reuses gh auth)
 *   2. raw.githubusercontent.com direct fetch (fallback)
 *
 * Node.js built-in modules only; no third-party dependencies.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_REPO = 'awesome-dsh-plugin/awesome-dsh-plugin';
const SRC_URL = `https://github.com/${SRC_REPO}/blob/main/README.md`;

/* awesome category → DeepGuard category (seven-value enum: ui/tools/sandbox/bridge/model/memory/workflow)
 * preliminary guess only; the audit agent judges by actual code shape (see report-contract.md §4) */
const CAT_MAP = {
  'UI Enhancements': 'ui',
  'Themes & Appearance': 'ui',
  'Sessions & Messages': 'ui',
  'Memory': 'memory',
  'Tools & Capabilities': 'tools',
  'Skills': 'tools',
  'Workflow & Automation': 'workflow',
  'Notifications & Integrations': 'bridge',
  'Models & Providers': 'model',
  'Development & Runtime': 'sandbox',
  'Usage & Billing': 'tools',
  'Plugin Markets & Managers': 'tools',
  'Just for Fun': 'ui'
};

/* ---------- fetch README ---------- */
function fetchReadme() {
  try {
    return execFileSync('gh', [
      'api', `repos/${SRC_REPO}/readme`,
      '-H', 'Accept: application/vnd.github.raw'
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    console.error(`gh api fetch failed (${e.message.split('\n')[0]}), falling back to raw direct fetch…`);
  }
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get(`https://raw.githubusercontent.com/${SRC_REPO}/main/README.md`, res => {
      if (res.statusCode !== 200) return reject(new Error(`raw direct fetch HTTP ${res.statusCode}`));
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

/* ---------- parsing ---------- */
const ENTRY_RE = /^-\s+\[(?<label>[^\]]+)\]\((?<url>https:\/\/github\.com\/[^)\s]+)\)\s*(?:-\s*(?<desc>.*))?$/;

function parse(markdown) {
  const lines = markdown.split('\n');
  const plugins = [];
  const warnings = [];
  let inPlugins = false;
  let category = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^##\s+/.test(line)) {
      if (/^##\s+Plugins/.test(line)) { inPlugins = true; continue; }
      if (inPlugins) break; // the next level-2 heading (Badge/Disclaimer) ends the section
    }
    if (!inPlugins) continue;

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) { category = h3[1].trim(); continue; }

    const m = line.match(ENTRY_RE);
    if (!m) continue;
    if (!category) { warnings.push(`entry without category context: ${m.groups.label}`); continue; }

    // URL breakdown: https://github.com/<owner>/<repo>[/tree/<branch>/<subpath…>]
    const parts = m.groups.url.replace(/\/+$/, '').split('/');
    const owner = parts[3] || '';
    const repo = parts[4] || '';
    if (!owner || !repo) { warnings.push(`unparseable repo URL: ${m.groups.url}`); continue; }
    let subpath = null;
    if (parts[5] === 'tree' && parts.length > 7) subpath = parts.slice(7).join('/');

    plugins.push({
      owner,
      repo,
      // canonical lowercase dedup key (GitHub names are case-insensitive); owner/repo keep display case
      url: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
      subpath,
      category_awesome: category,
      category: CAT_MAP[category] || null,
      desc: (m.groups.desc || '').trim()
    });
    if (!CAT_MAP[category]) warnings.push(`category "${category}" has no mapping, set to null: ${owner}/${repo}`);
    if (!m.groups.desc) warnings.push(`missing description: ${owner}/${repo}`);
  }
  return { plugins, warnings };
}

/* ---------- id normalization (schema: ^[a-z0-9][a-z0-9-]*[a-z0-9]$, 3–64 chars) ---------- */
function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* non-distinctive generic subdirectory names: using them directly would collide en masse, so fall back to the repo name */
const GENERIC_BASENAME = new Set(['plugin', 'plugins', 'bundle', 'kit', 'dsh', 'src', 'app', 'main', 'pkg', 'packages']);

function clampId(id) {
  if (id.length > 64) id = id.slice(0, 64).replace(/-+$/g, '');
  return id.length >= 3 ? id : null;
}

function assignIds(plugins) {
  const used = new Map(); // id -> "owner/repo/subpath"
  const collisions = [];
  for (const p of plugins) {
    const key = `${p.owner}/${p.repo}/${p.subpath || ''}`;
    const subBase = p.subpath ? p.subpath.split('/').pop() : null;
    // monorepo subpackage: the last subpath segment serves as id base only if it is not a generic word; otherwise use the repo name
    const base = (subBase && !GENERIC_BASENAME.has(subBase.toLowerCase())) ? subBase : p.repo;

    // candidate chain: base → base-subBase (when repo name is the base and a subpath exists) → base-owner
    const candidates = [slugify(base)];
    if (subBase && slugify(base) !== slugify(subBase)) candidates.push(slugify(`${base}-${subBase}`));
    candidates.push(slugify(`${base}-${p.owner}`));

    let picked = null;
    for (const c of candidates) {
      const id = clampId(c);
      if (!id) continue;
      if (!used.has(id) || used.get(id) === key) { picked = id; break; }
    }
    if (!picked) {
      collisions.push(`!! unresolvable name collision: ${key} (all candidates taken: ${candidates.join(' / ')}); manual naming required`);
      p.id = null;
      continue;
    }
    if (picked !== slugify(base)) collisions.push(`${slugify(base)}: ${used.get(slugify(base))} vs ${key} → the latter renamed to ${picked}`);
    used.set(picked, key);
    p.id = picked;
  }
  return collisions;
}

/* ---------- main flow ---------- */
async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? args[outIdx + 1] : path.join(ROOT, '_import', 'catalog.json');
  const limIdx = args.indexOf('--limit');
  const limit = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : Infinity;

  const md = await fetchReadme();
  const { plugins, warnings } = parse(md);
  const collisions = assignIds(plugins);

  const valid = plugins.filter(p => p.id).slice(0, limit);

  const catalog = {
    generated_at: new Date().toISOString(),
    source: SRC_URL,
    total: valid.length,
    plugins: valid
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  // summary
  const byCat = {};
  for (const p of valid) byCat[p.category_awesome] = (byCat[p.category_awesome] || 0) + 1;
  console.log(`collection complete: ${valid.length} plugins → ${path.relative(ROOT, outPath)}`);
  console.log('category distribution (awesome category → DeepGuard category):');
  for (const [cat, n] of Object.entries(byCat)) {
    console.log(`  ${cat} → ${CAT_MAP[cat] || 'unmapped'}: ${n}`);
  }
  const mono = valid.filter(p => p.subpath);
  if (mono.length) {
    console.log(`${mono.length} monorepo subpackage entries:`);
    mono.forEach(p => console.log(`  ${p.id} ← ${p.owner}/${p.repo}/${p.subpath}`));
  }
  if (collisions.length) { console.log('name collision handling:'); collisions.forEach(c => console.log(`  ${c}`)); }
  if (warnings.length) { console.log(`${warnings.length} parse warning(s):`); warnings.slice(0, 20).forEach(w => console.log(`  ${w}`)); }
}

main().catch(e => { console.error(`collection failed: ${e.message}`); process.exit(1); });
