#!/usr/bin/env node
/**
 * llm-error-feedback.mjs — render the issue comment for an LLM runtime error (pure script, zero deps)
 *
 * Reads the llm-error.json sentinel written by the harness (see harness.ts error classification),
 * looks the matched rule up in agent/config/llm-error-policy.json, renders the rule's issue
 * template with placeholder substitution, and emits a meta sidecar the workflow uses to decide
 * whether to close the issue and what queue status to record.
 *
 * Placeholders: {PLUGIN_ID} {REPO_URL} {VERSION} {COMMIT} {ENDPOINT} {MODEL} {ROLE}
 *               {HTTP_STATUS} {CATEGORY} {ERROR_DETAIL} {TIMESTAMP} {RETRY_INFO} {REASON_CODE}
 *
 * Usage:
 *   node llm-error-feedback.mjs --policy <llm-error-policy.json> --sentinel <llm-error.json> \
 *     --plugin-id <id> --repo-url <url> --version <v> --commit <c> \
 *     --endpoint <name> --model <model> --out <comment.md> --meta-out <meta.json>
 *
 * Exit codes: 0 rendered; 1 unreadable policy/sentinel or unknown rule (caller falls back to the
 * generic status-based comment).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  for (const k of ["policy", "sentinel", "plugin-id", "out", "meta-out"]) {
    if (!out[k]) { console.error(`missing --${k}`); process.exit(1); }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const policy = JSON.parse(readFileSync(args.policy, "utf8"));
const sentinel = JSON.parse(readFileSync(args.sentinel, "utf8"));
const rule = (policy.rules ?? []).find((r) => r.id === sentinel.rule_id);
if (!rule) {
  console.error(`unknown rule_id in sentinel: ${sentinel.rule_id}`);
  process.exit(1);
}
const issue = rule.issue ?? {};
const templateRel = issue.template;
if (!templateRel) {
  console.error(`rule ${rule.id} has no issue.template`);
  process.exit(1);
}
// Template paths in the policy resolve relative to the policy file's own directory — the same
// policy works from agent/config/ (core layout) and scripts/ (public-repo export layout)
const templatePath = join(policy.templates_dir ?? dirname(args.policy), templateRel);
const template = readFileSync(templatePath, "utf8");

const ROLE_BY_MODE = { audit: "sonar", review: "aegis", judge: "beacon", translate: "translate", harbor: "harbor", preflight: "preflight" };
const retry = rule.retry ?? {};
const retryInfo =
  (retry.max_attempts ?? 0) > 0
    ? `retried ${retry.max_attempts}x with ${retry.backoff ?? "exponential"} backoff, still failing`
    : "no retry (deterministic error)";

const map = {
  PLUGIN_ID: args["plugin-id"],
  REPO_URL: args["repo-url"] ?? "n/a",
  VERSION: args.version ?? "n/a",
  COMMIT: args.commit ?? "n/a",
  ENDPOINT: args.endpoint ?? "n/a",
  MODEL: args.model ?? "n/a",
  ROLE: ROLE_BY_MODE[sentinel.mode] ?? String(sentinel.mode ?? "unknown"),
  HTTP_STATUS: sentinel.status !== null && sentinel.status !== undefined ? String(sentinel.status) : "n/a",
  CATEGORY: sentinel.category ?? rule.category ?? "unclassified",
  ERROR_DETAIL: String(sentinel.error ?? "").slice(0, 500),
  TIMESTAMP: sentinel.at ?? new Date().toISOString(),
  RETRY_INFO: retryInfo,
  REASON_CODE: issue.reason_code ?? rule.id,
};
const rendered = template.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in map ? map[k] : m));
writeFileSync(args.out, rendered);
writeFileSync(
  args["meta-out"],
  JSON.stringify(
    {
      rule_id: rule.id,
      category: rule.category ?? null,
      close: issue.close === true,
      queue_status: issue.queue_status ?? null,
      template: templateRel,
    },
    null,
    2,
  ) + "\n",
);
console.log(`rendered rule=${rule.id} close=${issue.close === true} queue_status=${issue.queue_status ?? "n/a"}`);
