#!/usr/bin/env node
/**
 * issue-stages.js — render the per-stage conclusions table for the issue feedback comment
 * (machine-maintained, no AI, zero dependencies)
 *
 * The issue comment is the submission's permanent public record. Every agent role's finding and
 * conclusion must be visible there — including which stage produced NO output (crash / skipped),
 * so anomalies can be reviewed without digging through workflow logs.
 *
 * The same facts are stored machine-readable in reports/_audit-log.json (entry.stages) by
 * scripts/audit-log.js collect; this renderer is the human-readable twin.
 *
 * Data sources (all local files, all optional — missing input degrades a row, never the script):
 *   --queue-file <f>   queue record (gate reasons, final queue status, postcheck rejection reason)
 *   --sonar-dir <dir>  Sonar outbox (report.json | inapplicable.json)
 *   --aegis-dir <dir>  Aegis outbox (review.json)
 *   --beacon-dir <dir> Beacon outbox (verdict.json)
 *   --out <path>       output markdown fragment (default: stdout)
 *
 * Display vocabulary follows T6/D1: internal enum values (needs_human) are rendered with the
 * external vocabulary ("extended review") — the issue surface never shows the internal term.
 *
 * Availability contract: this is display code for the feedback path. On any internal error it
 * emits a minimal fallback fragment and exits 0 (the error goes to stderr / run logs) — a comment
 * with a degraded table beats no comment.
 */
const fs = require("fs");

// ---------- args ----------
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

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
};

// ---------- markdown cell/text hygiene ----------
// All rendered fields are LLM-produced or plugin-influenced free text: bound the length, flatten
// newlines, neutralize table pipes and backticks. Display-only; no execution surface.
// Truncation cuts at a word boundary and marks the cut with an ellipsis — never mid-token.
// T-11: `](` → `]\(` breaks the markdown link syntax without touching bare `[P1]`-style prefixes —
// an issue-comment cell must never render as a clickable link.
const clip = (s, n) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut) + "…";
};
const clean = (v, n = 200) =>
  clip(
    String(v ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\|/g, "\\|")
      .replace(/`/g, "'")
      .replace(/\]\(/g, "]\\(")
      .trim(),
    n
  );

// English-only issue surface: agent prose is Chinese by prompt design, so any free-text cell
// containing CJK is swapped for a fixed English label instead of leaking prose onto the public
// record. Negative conclusions still carry an explanation — rendered as structured English facts
// (counts, check names), never as quoted agent notes.
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const en = (v, fallback, n = 160) => {
  const s = clean(v, n);
  if (!s || CJK_RE.test(s)) return fallback;
  return s;
};

const VERDICT_ICON = { clean: "✅", risk: "⚠️", blocked: "🛑" };
const AEGIS_DISPLAY = {
  approve: ["✅", "approve"],
  reject: ["⛔", "reject"],
  needs_human: ["🔍", "extended review"], // T6/D1: internal enum → external vocabulary
  "injection-suspect": ["🚨", "injection suspect"],
};
const BEACON_DISPLAY = {
  uphold_sonar: ["✅", "uphold Sonar"],
  uphold_aegis: ["⛔", "uphold Aegis"],
  escalate: ["🔍", "escalated"],
};
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

function render(args) {
  const queue = args["queue-file"] ? readJson(args["queue-file"]) : null;
  const report = args["sonar-dir"] ? readJson(`${args["sonar-dir"]}/report.json`) : null;
  const inapplicable = args["sonar-dir"] ? readJson(`${args["sonar-dir"]}/inapplicable.json`) : null;
  const review = args["aegis-dir"] ? readJson(`${args["aegis-dir"]}/review.json`) : null;
  const beacon = args["beacon-dir"] ? readJson(`${args["beacon-dir"]}/verdict.json`) : null;

  const status = queue?.status ?? "unknown";
  const gateReasons = Array.isArray(queue?.gate?.reasons) ? queue.gate.reasons : [];
  const gateRejected = status === "rejected" && gateReasons.length > 0;
  const postRejected =
    status === "rejected" &&
    (() => {
      const h = [...(queue?.history ?? [])].reverse().find((e) => e.action === "rejected" && e.reason);
      return h ? String(h.reason) : null;
    })();

  const rows = [];
  const row = (stage, role, conclusion) => rows.push(`| ${stage} | ${role} | ${conclusion} |`);

  // 1. Intake gate — positive outcomes render bare; only failures carry an explanation
  if (gateRejected) row("Intake Gate", "deterministic", `⛔ \`rejected\` — ${en(gateReasons.join("; "), "see the run logs for gate reasons")}`);
  else row("Intake Gate", "deterministic", "✅ `pass`");

  // 2. Sonar (static audit)
  if (gateRejected) row("Static Audit", "Sonar", "➖ not reached");
  else if (inapplicable) row("Static Audit", "Sonar", `⛔ \`inapplicable\` — ${en(inapplicable.reason, "not a dsh-ecosystem plugin")}`);
  else if (report) {
    const v = report.summary?.overall_result ?? "unknown";
    const findings = Array.isArray(report.findings) ? report.findings : [];
    if (v === "clean" || findings.length === 0) {
      row("Static Audit", "Sonar", `${VERDICT_ICON[v] ?? "❔"} \`${v}\``);
    } else {
      // negative outcome: severity breakdown as structured facts
      const sev = {};
      for (const f of findings) {
        const s = String(f.severity ?? "INFO").toUpperCase();
        sev[s] = (sev[s] ?? 0) + 1;
      }
      const breakdown = Object.keys(SEVERITY_RANK)
        .filter((s) => sev[s])
        .map((s) => `${sev[s]} ${s.toLowerCase()}`)
        .join(", ");
      row("Static Audit", "Sonar", `${VERDICT_ICON[v] ?? "❔"} \`${v}\` — ${findings.length} finding${findings.length === 1 ? "" : "s"} (${breakdown})`);
    }
  } else row("Static Audit", "Sonar", "➖ no report produced (agent crashed / token exhausted — see run logs)");

  // 3. Aegis (independent review)
  if (gateRejected || inapplicable) row("Independent Review", "Aegis", "➖ not reached");
  else if (review) {
    const [icon, label] = AEGIS_DISPLAY[review.verdict] ?? ["❔", clean(review.verdict ?? "unknown", 40)];
    // install_check is Aegis's independent re-review of the published install command (full-40 hash,
    // subpath, mechanical shape) — surface it explicitly; a failed check makes the command untrustworthy
    // even when the audit itself was approved
    const ic = review.install_check;
    const install = ic ? ` · install command ${ic.command_ok === false ? "⛔" : "✅"}` : "";
    let detail = "";
    if (review.verdict !== "approve") {
      // negative outcome: structured English facts instead of (Chinese) reviewer prose
      const facts = [];
      if (ic && ic.command_ok === false) facts.push("install command failed verification");
      if (review.blacklist_check && review.blacklist_check.consistent === false) facts.push("blacklist recommendation inconsistent");
      const unverified = Array.isArray(review.per_finding) ? review.per_finding.filter((f) => f && f.evidence_ok === false).length : 0;
      if (unverified) facts.push(`${unverified} finding${unverified === 1 ? "" : "s"} with unverified evidence`);
      const missed = Array.isArray(review.missed_concerns) ? review.missed_concerns.length : 0;
      if (missed) facts.push(`${missed} missed concern${missed === 1 ? "" : "s"} raised`);
      if (!facts.length) facts.push("see the review artifact in the run logs");
      detail = ` — ${facts.join("; ")}`;
    }
    row("Independent Review", "Aegis", `${icon} \`${label}\`${install}${detail}`);
  } else if (report) row("Independent Review", "Aegis", "➖ no review produced (see run logs)");
  else row("Independent Review", "Aegis", "➖ not reached");

  // 4. Beacon (dispute arbitration) — convened only on a split verdict
  const BEACON_CONSEQUENCE = {
    uphold_sonar: "report stands, publish proceeds",
    uphold_aegis: "publish rejected",
    escalate: "flagged for extended review",
  };
  if (beacon) {
    const [icon, label] = BEACON_DISPLAY[beacon.ruling] ?? ["❔", clean(beacon.ruling ?? "unknown", 40)];
    const consequence = BEACON_CONSEQUENCE[beacon.ruling];
    row("Dispute Arbitration", "Beacon", `${icon} \`${label}\`${consequence ? ` — ${consequence}` : ""}`);
  } else if (review && review.verdict === "approve") row("Dispute Arbitration", "Beacon", "➖ not convened (no dispute)");
  else if (review) row("Dispute Arbitration", "Beacon", "➖ no ruling produced (see run logs)");
  else row("Dispute Arbitration", "Beacon", "➖ not reached");

  // 5. Deterministic postcheck (publish gate)
  if (status === "audited") row("Deterministic Postcheck", "script", "✅ `pass`");
  else if (postRejected) row("Deterministic Postcheck", "script", `⛔ \`fail\` — ${en(postRejected, "see the run logs for postcheck reasons", 300)}`);
  else if (status === "needs-human") row("Deterministic Postcheck", "script", "🔍 flagged for extended review");
  else row("Deterministic Postcheck", "script", "➖ not reached");

  // The final mirror gate (Guard/Harbor/merge) runs in the private index repo after publish and
  // cannot be observed from here — its per-stage conclusions are posted by the follow-up
  // "DeepGuard Final Gate" receipt comment, so this table intentionally ends at postcheck.

  const out = ["### Stage Conclusions", "", "| Stage | Role | Conclusion |", "| --- | --- | --- |", ...rows];

  // Findings appendix (top 5 by severity; titles rendered in English per issue-channel convention)
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  if (findings.length > 0) {
    const sorted = [...findings].sort(
      (a, b) => (SEVERITY_RANK[String(a.severity).toUpperCase()] ?? 9) - (SEVERITY_RANK[String(b.severity).toUpperCase()] ?? 9)
    );
    out.push("", `**Findings (${findings.length})**${findings.length > 5 ? " — top 5 by severity" : ""}:`, "");
    for (const f of sorted.slice(0, 5)) {
      const title = clean(f.title?.en ?? f.title?.zh ?? f.finding_id ?? "untitled", 140);
      out.push(`- \`${clean(f.finding_id ?? "FND-?", 20)}\` ${clean(String(f.severity ?? "?").toUpperCase(), 10)} — ${title}`);
    }
    if (findings.length > 5) out.push(`- …and ${findings.length - 5} more in the full report`);
  }

  out.push("");
  return out.join("\n");
}

// ---------- main ----------
let fragment;
try {
  fragment = render(parseArgs(process.argv.slice(2)));
} catch (e) {
  console.error(`[issue-stages] renderer error: ${e?.message ?? e}`);
  fragment = "### Stage Conclusions\n\n_Stage conclusions unavailable (renderer error — see run logs)._\n";
}
const outPath = parseArgs(process.argv.slice(2)).out;
if (outPath) fs.writeFileSync(outPath, fragment);
else process.stdout.write(fragment);
