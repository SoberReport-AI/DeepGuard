#!/usr/bin/env node
/**
 * audit-log.js — audit ledger (machine-maintained, no AI, zero dependencies)
 *
 * Data source: reports/_audit-log.json (newest first, capped at 200 entries)
 * Rendered output: AUDIT-LOG.md (all entries)
 *
 * Usage:
 *   node scripts/audit-log.js collect --queue-file <f> --gate-decision <pass|reject|''>
 *        [--gate-reasons s] [--submitter u] [--outbox-sonar dir] [--outbox-aegis dir] [--outbox-beacon dir]
 *        [--result-publish <success|failure|skipped>] [--pr url] [--run-url url] [--issue-url url]
 *   node scripts/audit-log.js record --id X --version v --commit c [fields...]
 *   node scripts/audit-log.js sync      # once a PR merge lands the report on disk → pr-open auto-flips to merged
 *   node scripts/audit-log.js mark --id X --version v --commit c --status <rejected|triaged|merged> [--reason s]
 *   node scripts/audit-log.js migrate [--repo-slug o/r]   # one-off: terminology migration (extended_review /
 *        not-dsh-plugin) + backfill issue links from the queue files; safe to re-run (idempotent)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LOG_JSON = path.join(ROOT, "reports", "_audit-log.json");
const MD_ALL = path.join(ROOT, "AUDIT-LOG.md");
const CAP = 200;

// ---------- argument parsing ----------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

// ---------- data source read/write ----------
function loadLog() {
  if (!fs.existsSync(LOG_JSON)) return { version: 1, entries: [] };
  return JSON.parse(fs.readFileSync(LOG_JSON, "utf-8"));
}

function saveLog(log) {
  log.entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  log.entries = log.entries.slice(0, CAP);
  fs.writeFileSync(LOG_JSON, JSON.stringify(log, null, 2) + "\n");
}

function upsert(entry) {
  const log = loadLog();
  const key = (e) => `${e.plugin_id}@${e.version}#${e.commit}`;
  const idx = log.entries.findIndex((e) => key(e) === key(entry));
  // Same triple + same run → in-place update (state progression within one pipeline run).
  // Same triple but a DIFFERENT run must NOT overwrite the earlier run's record — a late
  // gate-rejected (already-audited) re-dispatch would otherwise erase the merged terminal
  // fact and desync the ledger from the reports/ tree (this swallowed dsh-mermaid's merged
  // entry on 2026-08-21 when issue #40 was re-dispatched after its report had landed).
  const sameRun = idx >= 0 && (log.entries[idx].run_url ?? null) === (entry.run_url ?? null);
  if (idx >= 0 && sameRun) log.entries[idx] = entry;
  else log.entries.unshift(entry);
  saveLog(log);
  return entry;
}

// ---------- rendering ----------
const STATUS_LABEL = {
  "pr-open": "auto-merge pending",
  merged: "merged",
  rejected: "rejected",
  "rejected-gate": "gate-rejected",
  "rejected-postcheck": "rejected (postcheck)",
  "not-dsh-plugin": "not a dsh plugin",
  failed: "failed, flagged for extended review",
  triaged: "triaged",
};
const REVIEW_LABEL = { approve: "approve", reject: "reject", extended_review: "extended review", "injection-suspect": "injection suspect" };
const BEACON_LABEL = { uphold_sonar: "uphold Sonar", uphold_aegis: "uphold Aegis", escalate: "escalated" };

// T6/D1 boundary rule: the pipeline keeps its internal enum (Aegis verdict `needs_human`, queue
// status `needs-human`) — but this ledger is a published, outward-facing artifact, so the external
// vocabulary is stored here. Map at the boundary; "needs_human" is never written to the ledger.
const mapReviewVerdict = (v) => (v === "needs_human" ? "extended_review" : (v ?? null));

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 8 * 3600e3); // Beijing time
  return d.toISOString().slice(0, 16).replace("T", " ");
}

// SEC-008: e.repo originates from the queue file (crossing the mirror channel); only build a link
// when it is a plain owner/repo in GitHub charset — anything else renders unlinked (no URL injection)
const GH_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// Same trust rule for issue links (workflow-supplied): a canonical GitHub issue URL or nothing
const GH_ISSUE_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/issues\/\d{1,10}$/;

function commitCell(e) {
  const short = (e.commit || "").slice(0, 7) || "—";
  if (e.repo && e.commit && GH_REPO_RE.test(e.repo) && /^[0-9a-f]{40}$/.test(e.commit)) return `[${short}](https://github.com/${e.repo}/commit/${e.commit})`;
  return short;
}

// Details points at the source issue (the submission's permanent record: intake → stage conclusions
// → final-gate receipt all live there); falls back to the audit PR, then the workflow run
function detailCell(e) {
  if (e.issue && GH_ISSUE_RE.test(e.issue)) {
    const n = e.issue.split("/").pop();
    return `[#${n}](${e.issue})`;
  }
  if (e.pr) {
    const n = String(e.pr).split("/").pop();
    return `[#${n}](${e.pr})`;
  }
  if (e.run_url) return `[run](${e.run_url})`;
  return "—";
}

const dash = (v) => (v === null || v === undefined || v === "" ? "—" : v);

// FND-006: escape free-text cells (reason comes from gate reasons / blacklist reason and can be
// influenced by LLM output; version comes from the plugin's package.json)
// T-11: also break the link syntax `](` → `]\(` (a ledger cell must never render as a clickable
// link — only commitCell/detailCell produce intentional links, from charset-validated parts) and
// cap the length; `[`/`]` alone are deliberately NOT escaped (keeps `[P1]`-style prefixes intact).
const cell = (v) =>
  v === null || v === undefined || v === ""
    ? "—"
    : String(v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\]\(/g, "]\\(").slice(0, 200);

function renderAll(log) {
  const lines = [
    "# Audit Ledger",
    "",
    "> Machine-generated (`scripts/audit-log.js`); do not edit by hand. Data source: [reports/_audit-log.json](reports/_audit-log.json).",
    "",
    "| Time (Beijing) | Plugin | Version | Commit | Submitter | Sonar Verdict | Findings | Aegis Review | Beacon Ruling | Postcheck | Status | Details |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const e of log.entries) {
    lines.push(
      `| ${fmtTs(e.ts)} | ${cell(e.plugin_id)} | ${cell(e.version)} | ${commitCell(e)} | ${cell(e.submitter)} | ${dash(e.verdict)} | ${e.findings ?? "—"} | ${dash(REVIEW_LABEL[e.review_aegis] || e.review_aegis)} | ${dash(BEACON_LABEL[e.beacon] || e.beacon)} | ${dash(e.postcheck)} | ${STATUS_LABEL[e.status] || e.status} | ${detailCell(e)} |`
    );
  }
  if (log.entries.length === 0) lines.push("| — | (empty) | | | | | | | | | | |");
  lines.push("");
  fs.writeFileSync(MD_ALL, lines.join("\n"));
}

function render(log) {
  renderAll(log);
}

// ---------- subcommands ----------
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/** Run metadata of an outbox (turns/usage/compactions), null when absent. Pipeline artifacts carry
 *  the packed form (run-result.json — trace-pack.ts strips the raw trace.jsonl before upload);
 *  the raw-trace scan remains as the legacy/local fallback. */
function readRunResult(dir) {
  if (!dir) return null;
  const packed = readJsonSafe(path.resolve(ROOT, dir, "run-result.json"));
  if (packed) return packed;
  try {
    const lines = fs.readFileSync(path.resolve(ROOT, dir, "trace.jsonl"), "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.type === "run_result") return rec;
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* no trace */
  }
  return null;
}

function cmdCollect(args) {
  const q = args["queue-file"] ? readJsonSafe(path.resolve(ROOT, args["queue-file"])) : null;
  const report = args["outbox-sonar"] ? readJsonSafe(path.resolve(ROOT, args["outbox-sonar"], "report.json")) : null;
  const review = args["outbox-aegis"] ? readJsonSafe(path.resolve(ROOT, args["outbox-aegis"], "review.json")) : null;
  const beacon = args["outbox-beacon"] ? readJsonSafe(path.resolve(ROOT, args["outbox-beacon"], "verdict.json")) : null;
  const inapplicable = args["outbox-sonar"] ? readJsonSafe(path.resolve(ROOT, args["outbox-sonar"], "inapplicable.json")) : null;
  const sonarRun = readRunResult(args["outbox-sonar"]);
  const aegisRun = readRunResult(args["outbox-aegis"]);
  // Compaction disclosure: >0 means older turns were summarized mid-run (evidence fidelity consumers
  // may weigh this); 0 = full-fidelity run; null = no trace available (crashed before run_result).
  const compactions = sonarRun || aegisRun ? (sonarRun?.compactions ?? 0) + (aegisRun?.compactions ?? 0) : null;

  // Per-stage conclusions (bounded free text; the issue feedback comment renders the same facts —
  // keeping them in the ledger makes reports/_audit-log.json the complete machine-readable record.
  // harbor: the final mirror gate runs in the private repo, so the public ledger cannot observe it;
  // the private side backfills it via the P2d mirror channel.)
  const cut = (v, n = 300) => (v === null || v === undefined ? null : String(v).slice(0, n));
  const stages = {
    sonar: report
      ? { verdict: report.summary?.overall_result ?? null, findings: Array.isArray(report.findings) ? report.findings.length : null }
      : inapplicable
        ? { inapplicable: cut(inapplicable.reason ?? "not a dsh-ecosystem plugin") }
        : null,
    aegis: review
      ? {
          verdict: mapReviewVerdict(review.verdict),
          notes: cut(review.notes),
          // Aegis's independent install-command re-review (full-40 hash / subpath / mechanical shape); null on legacy artifacts
          install_ok: review.install_check ? review.install_check.command_ok !== false : null,
        }
      : null,
    beacon: beacon ? { ruling: beacon.ruling ?? null, rationale: cut(beacon.rationale) } : null,
    harbor: null,
  };

  const issueUrl = args["issue-url"] && GH_ISSUE_RE.test(args["issue-url"]) ? args["issue-url"] : null;

  const entry = {
    ts: new Date().toISOString(),
    plugin_id: q?.id || args.id || "unknown",
    name: q?.name || null,
    /* the REPORT is authoritative for version/commit: prepare.mjs locks HEAD at audit time
       (prescreen.commit is only the intake-time observation, kept for the force-push signal),
       so when the repo moved between intake and audit the ledger must follow the audited
       snapshot, not the stale prescreen pin (dsh-tui 2026-08-20 divergence). */
    version: report?.plugin?.version || q?.prescreen?.version || null,
    commit: report?.plugin?.commit || q?.prescreen?.commit || null,
    repo: q?.repo || null,
    source: q?.source || null,
    submitter: args.submitter || null,
    verdict: report?.summary?.overall_result || null,
    findings: Array.isArray(report?.findings) ? report.findings.length : null,
    review_aegis: mapReviewVerdict(review?.verdict),
    beacon: beacon?.ruling || null,
    postcheck: null,
    stage_reached: null,
    status: null,
    issue: issueUrl,
    pr: args.pr || null,
    run_url: args["run-url"] || null,
    extended_review: false,
    reason: null,
    compactions,
    stages,
  };

  const gateDecision = args["gate-decision"] || "";
  if (gateDecision !== "pass") {
    entry.stage_reached = "gate";
    if (gateDecision === "reject") {
      entry.status = "rejected-gate";
      entry.reason = args["gate-reasons"] || "rejected at intake gate";
    } else {
      entry.status = "failed";
      entry.reason = "intake gate script error (see run logs)";
      entry.extended_review = true;
    }
  } else if (!report) {
    entry.stage_reached = "sonar";
    if (inapplicable) {
      // Sonar applicability terminal state: normal flow, does not enter the extended-review list
      entry.status = "not-dsh-plugin";
      entry.reason = String(inapplicable.reason || "not a dsh-ecosystem plugin").slice(0, 300);
    } else {
      entry.status = "failed";
      entry.reason = "Sonar produced no report (agent crashed or submission over size limit; see run logs)";
      entry.extended_review = true;
    }
  } else if (!review) {
    entry.stage_reached = "aegis";
    entry.status = "failed";
    entry.reason = "Aegis produced no review verdict (see run logs)";
    entry.extended_review = true;
  } else if (review.verdict !== "approve" && !beacon) {
    // Split verdict but Beacon produced no ruling (beacon job crashed / key not configured) — postcheck is likewise fail-closed to extended review
    entry.stage_reached = "beacon";
    entry.status = "failed";
    entry.reason = `split verdict (Aegis ${mapReviewVerdict(review.verdict)}) but Beacon produced no ruling (see run logs)`;
    entry.extended_review = true;
  } else if (args["result-publish"] === "success" && entry.pr) {
    entry.stage_reached = "publish";
    entry.status = "pr-open";
    entry.postcheck = "pass";
    entry.extended_review = true; // fully-automated mode: the ledger job runs `sync` right after collect (publish's auto-merge is already on main) to flip pr-open → merged; if stuck, auto-merge never landed and the entry is flagged for extended review
  } else {
    entry.stage_reached = "publish";
    // Publish produced no PR — two distinct causes, told apart by the queue status postcheck wrote:
    // deterministic check failure (queue → rejected, reason on the latest history entry) vs.
    // pipeline-side anomaly (queue → extended-review: crash / canary / translation mismatch), which
    // keeps the generic failed label for triage.
    if (q?.status === "rejected") {
      entry.status = "rejected-postcheck";
      const rej = [...(q?.history ?? [])].reverse().find((h) => h.action === "rejected" && h.reason);
      entry.reason = String(rej?.reason ?? "postcheck deterministic verification failed").slice(0, 300);
    } else {
      entry.status = "failed";
      entry.reason = "publish did not pass (postcheck FAIL, or push/PR creation failed; see run logs)";
      entry.extended_review = true;
    }
  }

  upsert(entry);
  render(loadLog());
  console.log(`[audit-log] ${entry.plugin_id} → ${entry.status}${entry.extended_review ? " (extended review)" : ""}`);
}

function cmdRecord(args) {
  const entry = {
    ts: args.ts || new Date().toISOString(),
    plugin_id: args.id,
    name: args.name || null,
    version: args.version || null,
    commit: args.commit || null,
    repo: args.repo || null,
    source: args.source || null,
    submitter: args.submitter || null,
    verdict: args.verdict || null,
    findings: args.findings !== undefined ? Number(args.findings) : null,
    review_aegis: mapReviewVerdict(args["review-aegis"]),
    beacon: args.beacon || null,
    postcheck: args.postcheck || null,
    stage_reached: args.stage || null,
    status: args.status,
    issue: args["issue-url"] && GH_ISSUE_RE.test(args["issue-url"]) ? args["issue-url"] : null,
    pr: args.pr || null,
    run_url: args["run-url"] || null,
    extended_review: ["pr-open", "failed"].includes(args.status),
    reason: args.reason || null,
    compactions: args.compactions !== undefined ? Number(args.compactions) : null,
    stages: null,
  };
  if (!entry.plugin_id || !entry.version || !entry.commit || !entry.status) {
    console.error("record requires --id --version --commit --status");
    process.exit(1);
  }
  upsert(entry);
  render(loadLog());
  console.log(`[audit-log] recorded ${entry.plugin_id}@${entry.version}#${entry.commit.slice(0, 7)} → ${entry.status}`);
}

function cmdSync() {
  const log = loadLog();
  let changed = 0;
  for (const e of log.entries) {
    if (e.status !== "pr-open") continue;
    const p = path.join(ROOT, "reports", e.plugin_id, e.version, `${e.commit}.json`);
    if (fs.existsSync(p)) {
      e.status = "merged";
      e.extended_review = false;
      changed++;
    }
  }
  if (changed) saveLog(log);
  render(log);
  console.log(`[audit-log] sync complete, ${changed} entries flipped to merged`);
}

function cmdMark(args) {
  const log = loadLog();
  const e = log.entries.find(
    (x) => x.plugin_id === args.id && x.version === args.version && x.commit === args.commit
  );
  if (!e) {
    console.error(`entry not found: ${args.id}@${args.version}#${args.commit}`);
    process.exit(1);
  }
  e.status = args.status;
  e.extended_review = false;
  if (args.reason) e.reason = args.reason;
  saveLog(log);
  render(log);
  console.log(`[audit-log] ${e.plugin_id} → ${args.status}`);
}

// One-off terminology migration + issue-link backfill. Idempotent: safe to re-run.
//   - field rename: needs_human → extended_review (value preserved; missing → derived from status)
//   - verdict labels: review_aegis "needs_human" → "extended_review"; status "not-dsh" → "not-dsh-plugin"
//   - issue URL backfilled from _import/audit-queue/<id>.json (queue `issue` number → canonical URL;
//     only filled when absent — a workflow-supplied issue link always wins)
//   - stages reshaped from the existing top-level verdict fields (same facts, restructured; never fabricated)
function cmdMigrate(args) {
  const slug = args["repo-slug"] && GH_REPO_RE.test(args["repo-slug"]) ? args["repo-slug"] : "SoberReport-AI/DeepGuard";
  const log = loadLog();
  let renamed = 0,
    relabeled = 0,
    linked = 0,
    reshaped = 0;
  for (const e of log.entries) {
    if ("needs_human" in e) {
      if (e.extended_review === undefined) e.extended_review = !!e.needs_human;
      delete e.needs_human;
      renamed++;
    }
    if (e.extended_review === undefined) e.extended_review = ["pr-open", "failed"].includes(e.status);
    if (e.review_aegis === "needs_human") {
      e.review_aegis = "extended_review";
      relabeled++;
    }
    if (e.status === "not-dsh") {
      e.status = "not-dsh-plugin";
      relabeled++;
    }
    if (!e.issue) {
      const q = readJsonSafe(path.join(ROOT, "_import", "audit-queue", `${e.plugin_id}.json`));
      if (q && q.id === e.plugin_id && Number.isInteger(q.issue) && q.issue > 0) {
        e.issue = `https://github.com/${slug}/issues/${q.issue}`;
        linked++;
      }
    }
    if (e.stages === undefined) {
      e.stages = {
        sonar: e.verdict != null || e.findings != null ? { verdict: e.verdict ?? null, findings: e.findings ?? null } : null,
        aegis: e.review_aegis != null ? { verdict: e.review_aegis, notes: null } : null,
        beacon: e.beacon != null ? { ruling: e.beacon, rationale: null } : null,
        harbor: null,
      };
      reshaped++;
    }
  }
  saveLog(log);
  render(log);
  console.log(
    `[audit-log] migrate: ${renamed} field renames, ${relabeled} terminology updates, ${linked} issue links backfilled, ${reshaped} stages reshaped`
  );
}

// ---------- main ----------
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === "collect") cmdCollect(args);
else if (cmd === "record") cmdRecord(args);
else if (cmd === "sync") cmdSync();
else if (cmd === "mark") cmdMark(args);
else if (cmd === "migrate") cmdMigrate(args);
else {
  console.error("usage: audit-log.js <collect|record|sync|mark|migrate> [flags]");
  process.exit(1);
}
