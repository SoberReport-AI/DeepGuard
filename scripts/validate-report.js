#!/usr/bin/env node
/**
 * DeepGuard report hard-gate validator (the same script runs locally and in CI)
 *
 * Usage:
 *   node scripts/validate-report.js <report-file...>       # validate specific reports
 *   node scripts/validate-report.js --all                  # validate all reports under reports/
 *
 * Checks (any failure = FAIL, exit code 1):
 *   1. JSON Schema structural validation (incl. verbatim-locked bilingual disclaimer, bound dimension
 *      names, verdict field enums)
 *   2. Path consistency: the three segments of reports/<plugin-id>/<version>/<commit>.json
 *      must equal plugin.id / plugin.version / plugin.commit inside the report
 *   3. Mechanical verdict rollup: summary.overall_result and market.verdict must be derived
 *      from dimension statuses and finding severities by rule; no manual inflation or deflation
 *   3.5 install_command equivalence: market.install_command must equal the mechanically derived
 *      command from scripts/install-command.js (SEC-005 — the raw report keeps this value, so an
 *      agent-written command pointing elsewhere must fail the gate)
 *   4. Cross-reference consistency: FND- ids referenced by dimension findings must exist in findings[]
 *   5. Bilingual completeness (v3): every human-readable field is a {zh, en} object; the publish
 *      hard gate requires both languages present and non-empty (the schema keeps `en` optional so
 *      the draft stage — Sonar submits zh only, the translate stage fills en — can validate)
 *   6. force-push detection: a second distinct commit under the same <plugin-id>/<version> → WARN
 *      (written to the WARN log; build-index.js turns it into an _advisories.json advisory)
 *
 * Dependencies: Node.js built-in modules + ajv (declared in scripts/package.json)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildInstallCommand } = require('./install-command');

/* ---------- minimal ajv substitute: avoids CI dependency installs; built-in Draft 2020-12 subset ---------- */
/* supported keywords: type / const / enum / required / properties / additionalProperties /
   items / minItems / maxItems / minLength / maxLength / pattern / oneOf /
   format:date-time / type arrays (["string","null"]) */

/* NOTE: dimension names are contract-bound verbatim in BOTH languages (the check below compares
   against report content) — do NOT translate or paraphrase. */
const DIM_NAMES = {
  'DG-D1': { zh: '凭据密钥窃取', en: 'Credential & Secret Theft' },
  'DG-D2': { zh: '提示词注入', en: 'Prompt Injection' },
  'DG-D3': { zh: '任意代码执行', en: 'Arbitrary Code Execution' },
  'DG-D4': { zh: '数据外泄', en: 'Data Exfiltration' },
  'DG-D5': { zh: '供应链风险', en: 'Supply Chain Risk' },
  'DG-D6': { zh: '运行时风险', en: 'Runtime Risk' }
};

function fail(msg) { return msg; }

/* deep equality for object-valued const (the bilingual disclaimer is const-locked per language) */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/* A human-readable field (v3) is structurally an object carrying a `zh` string and nothing else
   except the translate-stage-added `en` — the same rule used by agent/src/translate.ts and
   agent/scripts/postcheck.mjs (three independent implementations, one structural convention). */
function isBilingualSlot(node) {
  return (
    node !== null &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    typeof node.zh === 'string' &&
    Object.keys(node).every(k => k === 'zh' || k === 'en')
  );
}

function checkType(value, type, pathStr, errors) {
  if (Array.isArray(type)) {
    const ok = type.some(t => checkType(value, t, pathStr, []));
    if (!ok) errors.push(fail(`${pathStr}: expected type ${type.join('|')}, got ${describe(value)}`));
    return ok;
  }
  switch (type) {
    case 'string':  if (typeof value !== 'string') { errors.push(fail(`${pathStr}: expected string, got ${describe(value)}`)); return false; } return true;
    case 'boolean': if (typeof value !== 'boolean') { errors.push(fail(`${pathStr}: expected boolean`)); return false; } return true;
    case 'integer': if (!Number.isInteger(value)) { errors.push(fail(`${pathStr}: expected integer, got ${describe(value)}`)); return false; } return true;
    case 'null':    if (value !== null) { errors.push(fail(`${pathStr}: expected null`)); return false; } return true;
    case 'array':   if (!Array.isArray(value)) { errors.push(fail(`${pathStr}: expected array`)); return false; } return true;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(fail(`${pathStr}: expected object`)); return false; } return true;
    default: return true;
  }
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isValidDateTime(s) {
  // ISO 8601 with timezone, e.g. 2026-08-14T10:24:00+08:00
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !isNaN(Date.parse(s));
}

function validate(node, schema, pathStr, errors) {
  if (schema.oneOf) {
    const sub = schema.oneOf.filter(s => {
      // the null branch only passes when the node is actually null
      if (s.type === 'null') return node === null;
      if (node === null) return false;
      return validate(node, s, pathStr, []).length === 0;
    });
    if (sub.length !== 1) {
      errors.push(fail(`${pathStr}: oneOf validation failed (${sub.length} branches passed, exactly 1 required)`));
    }
    // after oneOf passes, continue with the other keywords at this level
  }
  if (schema.const !== undefined) {
    const constOk = schema.const !== null && typeof schema.const === 'object' ? deepEqual(node, schema.const) : node === schema.const;
    if (!constOk) {
      if (typeof schema.const === 'string' && DISCLAIMER_TEXTS.has(schema.const)) {
        errors.push(fail(`${pathStr}: disclaimer differs from the contract-fixed text (verbatim lock in both languages, no additions or deletions allowed)`));
      } else {
        errors.push(fail(`${pathStr}: must equal constant ${JSON.stringify(schema.const)}`));
      }
    }
  }
  if (schema.enum && !schema.enum.includes(node)) {
    errors.push(fail(`${pathStr}: must be within enum [${schema.enum.join(', ')}], got ${JSON.stringify(node)}`));
  }
  if (schema.type !== undefined && !checkType(node, schema.type, pathStr, errors)) return errors;
  if (schema.format === 'date-time' && typeof node === 'string' && !isValidDateTime(node)) {
    errors.push(fail(`${pathStr}: not a valid ISO 8601 date-time: ${node}`));
  }
  if (typeof node === 'string') {
    if (schema.minLength !== undefined && node.length < schema.minLength) errors.push(fail(`${pathStr}: length < ${schema.minLength}`));
    if (schema.maxLength !== undefined && node.length > schema.maxLength) errors.push(fail(`${pathStr}: length > ${schema.maxLength}`));
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) errors.push(fail(`${pathStr}: does not match pattern ${schema.pattern}, got ${JSON.stringify(node)}`));
  }
  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) errors.push(fail(`${pathStr}: item count < ${schema.minItems}`));
    if (schema.maxItems !== undefined && node.length > schema.maxItems) errors.push(fail(`${pathStr}: item count > ${schema.maxItems}`));
    if (schema.items) node.forEach((item, i) => validate(item, schema.items, `${pathStr}[${i}]`, errors));
  }
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in node)) errors.push(fail(`${pathStr}.${key}: missing required field`));
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in node) validate(node[key], sub, `${pathStr}.${key}`, errors);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(node)) {
          if (!(key in schema.properties)) errors.push(fail(`${pathStr}.${key}: field not defined in contract (additionalProperties=false)`));
        }
      }
    }
  }
  return errors;
}

/* ---------- semantic rules (mechanical checks beyond the schema) ---------- */

function semanticChecks(rpt, filePath, errors, warnings) {
  if (!rpt || !rpt.summary || !rpt.dimensions) return; // schema already reported errors; skip semantic checks

  // 1. path consistency: reports/<id>/<version>/<commit>.json
  const parts = filePath.split(path.sep);
  const ri = parts.lastIndexOf('reports');
  if (ri === -1 || parts.length - ri !== 4) {
    errors.push(fail(`invalid path: must be reports/<plugin-id>/<version>/<commit>.json (got ${filePath})`));
  } else {
    const [, , , idDir, verDir, commitFile] = parts.slice(0); // placeholder
    const id = parts[ri + 1], ver = parts[ri + 2], com = parts[ri + 3].replace(/\.json$/, '');
    if (id !== rpt.plugin.id) errors.push(fail(`path ID "${id}" ≠ report plugin.id "${rpt.plugin.id}"`));
    if (ver !== rpt.plugin.version) errors.push(fail(`path version "${ver}" ≠ report plugin.version "${rpt.plugin.version}"`));
    if (com !== rpt.plugin.commit) errors.push(fail(`path commit "${com}" ≠ report plugin.commit "${rpt.plugin.commit}"`));
  }

  // 2. dimension names are hard-bound in both languages
  for (const d of rpt.dimensions || []) {
    const bound = DIM_NAMES[d.dimension];
    if (bound && (!d.name || d.name.zh !== bound.zh || d.name.en !== bound.en)) {
      errors.push(fail(`dimensions.${d.dimension}.name must be {zh: "${bound.zh}", en: "${bound.en}"}, got ${JSON.stringify(d.name)}`));
    }
  }
  // dimensions must be complete and deduplicated
  const dims = (rpt.dimensions || []).map(d => d.dimension).sort().join(',');
  if (dims !== 'DG-D1,DG-D2,DG-D3,DG-D4,DG-D5,DG-D6') errors.push(fail(`dimensions must contain exactly DG-D1–DG-D6 without duplicates, got [${dims}]`));
  const ovDims = (rpt.summary.dimension_overview || []).map(d => d.dimension).sort().join(',');
  if (ovDims !== 'DG-D1,DG-D2,DG-D3,DG-D4,DG-D5,DG-D6') errors.push(fail(`summary.dimension_overview must contain exactly DG-D1–DG-D6, got [${ovDims}]`));

  // 3. summary and dimensions must agree per dimension
  for (const o of rpt.summary.dimension_overview || []) {
    const d = (rpt.dimensions || []).find(x => x.dimension === o.dimension);
    if (!d) continue;
    if (d.status !== o.status) errors.push(fail(`${o.dimension}: summary status "${o.status}" ≠ dimensions status "${d.status}"`));
    if (d.findings.length !== o.findings) errors.push(fail(`${o.dimension}: summary findings count "${o.findings}" ≠ dimensions actual "${d.findings.length}"`));
  }

  // 4. mechanical verdict rollup
  const dimStatus = (rpt.dimensions || []).map(d => d.status);
  const hasRiskDim = dimStatus.includes('risk');
  const hasCritical = (rpt.findings || []).some(f => f.severity === 'CRITICAL');
  const rugPull = !!(rpt.version_diff && rpt.version_diff.rug_pull_signal);
  let expect = 'clean';
  if (hasCritical || rugPull) expect = 'blocked';
  else if (hasRiskDim) expect = 'risk';
  if (rpt.summary.overall_result !== expect) {
    errors.push(fail(`summary.overall_result "${rpt.summary.overall_result}" disagrees with the mechanically derived "${expect}" (CRITICAL findings=${hasCritical}, rug_pull=${rugPull}, risk dimensions=${hasRiskDim})`));
  }
  if (rpt.market.verdict !== rpt.summary.overall_result) {
    errors.push(fail(`market.verdict "${rpt.market.verdict}" must equal summary.overall_result "${rpt.summary.overall_result}"`));
  }

  // 5. key_findings / findings cross-references
  const findingIds = new Set((rpt.findings || []).map(f => f.finding_id));
  if (findingIds.size !== (rpt.findings || []).length) errors.push(fail('findings contain duplicate finding_id'));
  for (const kf of rpt.summary.key_findings || []) {
    if (!findingIds.has(kf)) errors.push(fail(`summary.key_findings references non-existent ${kf}`));
  }
  for (const d of rpt.dimensions || []) {
    for (const fid of d.findings) {
      if (!findingIds.has(fid)) errors.push(fail(`dimensions.${d.dimension}.findings references non-existent ${fid}`));
      else {
        const f = rpt.findings.find(x => x.finding_id === fid);
        if (f.dimension !== d.dimension) errors.push(fail(`${fid} is filed under ${d.dimension}, but the finding's own dimension is ${f.dimension}`));
      }
    }
  }
  // a risk dimension must carry at least one finding; clean/na dimensions must carry none
  for (const d of rpt.dimensions || []) {
    if (d.status === 'risk' && d.findings.length === 0) errors.push(fail(`${d.dimension} judged risk but carries no findings`));
    if (d.status !== 'risk' && d.findings.length > 0) errors.push(fail(`${d.dimension} judged ${d.status} but carries ${d.findings.length} findings`));
  }

  // 6. a blocked verdict must not offer an install command
  if (rpt.market.verdict === 'blocked' && rpt.market.install_command !== null) {
    errors.push(fail('market.install_command must be null when verdict is blocked'));
  }

  // 6.5 install command must not contain placeholders: it must be a complete, copy-paste-runnable command
  // (the publish layer mechanically reassembles this field via build-index, but raw reports with
  // <...> placeholders are equally barred from the repository)
  if (typeof rpt.market.install_command === 'string' && /<[a-zA-Z][^>]*>/.test(rpt.market.install_command)) {
    errors.push(fail('market.install_command contains <...> placeholders; must be a complete executable command'));
  }

  // 6.6 SEC-005: install_command equivalence — the only legitimate value is the mechanically derived
  // command (install-command.js single source of truth). The publish layer reassembles this field for
  // web/reports, but the RAW report in reports/ keeps the agent-written value and users may copy from
  // it directly; a prompt-injected command pointing at an attacker's repo must fail the hard gate.
  {
    let cmdMeta = {};
    try { cmdMeta = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(filePath)), '_meta.json'), 'utf8')); }
    catch { /* _meta.json is market ops data and absent pre-publish / in the mirror channel — defaults apply */ }
    const expectCmd = buildInstallCommand(rpt, cmdMeta);
    if (rpt.market.install_command !== expectCmd) {
      errors.push(fail(`market.install_command must equal the mechanically derived command (expected ${JSON.stringify(expectCmd)}, got ${JSON.stringify(rpt.market.install_command)})`));
    }
  }

  // 7. DG-S scenario full coverage: DG-S01–DG-S12 must each appear in at least one dimension
  const allDs = new Set();
  for (const d of rpt.dimensions || []) for (const s of d.ds_scenarios) allDs.add(s.id);
  const missing = [];
  for (let i = 1; i <= 12; i++) {
    const id = 'DG-S' + String(i).padStart(2, '0');
    if (!allDs.has(id)) missing.push(id);
  }
  if (missing.length) errors.push(fail(`dsh-specific attack scenarios not fully covered, missing: ${missing.join(', ')}`));

  // 8. bilingual completeness: every human-readable slot ({zh} object) must also carry a non-empty en.
  // The schema keeps en optional so the draft stage validates; this hard gate is what makes published
  // reports guaranteed bilingual. The disclaimer slot is exempt here (its zh/en are const-locked).
  const mono = [];
  (function walkSlots(node, p) {
    if (Array.isArray(node)) { node.forEach((v, i) => walkSlots(v, `${p}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      if (isBilingualSlot(node)) {
        if (p !== 'report.disclaimer' && (typeof node.en !== 'string' || node.en.length === 0)) {
          mono.push(p);
        }
        return;
      }
      for (const [k, v] of Object.entries(node)) walkSlots(v, `${p}.${k}`);
    }
  })(rpt, 'report');
  if (mono.length) {
    errors.push(fail(`bilingual completeness: ${mono.length} human-readable field(s) missing a non-empty en (translate stage output absent or incomplete): ${mono.slice(0, 5).join(', ')}${mono.length > 5 ? ' …' : ''}`));
  }

  return { errors, warnings };
}

/* ---------- force-push advisory: multiple commits under the same id+version ---------- */
function forcePushScan(allFiles, warnings) {
  const seen = new Map(); // "id@version" -> Set(commit)
  for (const f of allFiles) {
    const parts = f.split(path.sep);
    const ri = parts.lastIndexOf('reports');
    if (ri === -1 || parts.length - ri !== 4) continue;
    const key = parts[ri + 1] + '@' + parts[ri + 2];
    const commit = parts[ri + 3].replace(/\.json$/, '');
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(commit);
  }
  for (const [key, commits] of seen) {
    if (commits.size > 1) {
      warnings.push(`force-push advisory: ${key} has ${commits.size} distinct commit snapshots (${[...commits].join(', ')}); an _advisories.json advisory should be generated and the plugin re-audited`);
    }
  }
  return warnings;
}

/* ---------- entry ---------- */
const DISCLAIMER_TEXTS = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reports', '_schema', 'deepguard-report.schema.json'), 'utf8')).properties.disclaimer;
  return new Set([d.properties.zh.const, d.properties.en.const]);
})();

function listReports(dir) {
  const out = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) { if (name !== '_schema') walk(fp); }
      else if (name.endsWith('.json') && !name.startsWith('_')) out.push(fp);
    }
  })(dir);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  let files;
  if (args[0] === '--all' || args.length === 0) {
    files = listReports(path.join(__dirname, '..', 'reports'));
  } else {
    files = args.map(a => path.resolve(a));
  }
  if (!files.length) {
    console.log('no report files found (no *.json under reports/)');
    process.exit(0);
  }

  const schemaPath = path.join(__dirname, '..', 'reports', '_schema', 'deepguard-report.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  let pass = 0, failCount = 0;
  const allWarnings = [];

  for (const f of files) {
    const rel = path.relative(path.join(__dirname, '..'), f);
    let rpt;
    try { rpt = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { console.log(`✗ ${rel}\n  JSON parse failed: ${e.message}`); failCount++; continue; }

    const errors = [];
    const warnings = [];
    validate(rpt, schema, 'report', errors);
    semanticChecks(rpt, f, errors, warnings);
    allWarnings.push(...warnings);

    if (errors.length) {
      failCount++;
      console.log(`✗ ${rel}`);
      errors.forEach(e => console.log(`  - ${e}`));
    } else {
      pass++;
      console.log(`✓ ${rel}`);
    }
  }

  forcePushScan(files.map(f => path.relative(path.join(__dirname, '..'), f)), allWarnings);
  allWarnings.forEach(w => console.log(`⚠ ${w}`));

  console.log(`\nvalidation complete: ${pass} passed, ${failCount} failed, ${allWarnings.length} warning(s)`);
  process.exit(failCount ? 1 : 0);
}

main();
