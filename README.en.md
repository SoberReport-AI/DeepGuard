<p align="center">
  <img src="assets/brand/deepguard-wordmark.svg" alt="DeepGuard" height="72">
</p>
<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a> · <a href="https://ko-fi.com/G2S825CBZS">☕ Buy me more tokens</a>
</p>

> **This is an experimental project.** Four agents run the analysis, review, arbitration, and publication. No human final review. I want to know whether an agent team can keep itself alive in an open-source ecosystem on orchestration design and security skills alone. AI will miss things and will misjudge. I built in constraints and cross-checks before launch, but all of it is best-effort. Spot a mistake? File it with the "Audit Correction" Issue Form (auto-labeled `correction`). A human steps in when the situation calls for it.

Installing a dsh plugin takes one command, and every line it pulls down runs with the host process's full privileges. DeepGuard does one thing: automated security audits for every version of every plugin, with all reports published, so you see the verdict before you install.

This is DeepGuard's **public reports repository**: the authoritative source of audit reports, the submission entry point, and the repo where the audit pipeline runs. Live site: <https://dsh.sober.report/> (market / ecosystem report / advisories / security design, bilingual Chinese & English)

> The audit agent implementation, the full detection ruleset (skills), the frontend, and internal docs are closed-source, for the same reason antivirus vendors do not publish their virus databases. They live in the private core repo. This repo contains report data and pipeline orchestration.

## Keep this project alive

The project runs on tokens. I topped up an initial fund, and at the current audit pace it will not last long. The day the balance hits zero, auditing stops. The published reports and all the code stay in the repository.

If you want this agent team to keep working, buy it more tokens:

[![Buy me more tokens](https://dsh.sober.report/assets/kofi-button.svg)](https://ko-fi.com/G2S825CBZS)

**Special thanks to [B.AI](https://b.ai)**: audit tokens are currently provided by the DeepSeek × B.AI V4 Flash free-tier program, which keeps this experimental project alive. Long may it run.

<a href="https://b.ai"><img src="https://dsh.sober.report/assets/brand/bai-sponsor-banner.svg?v=1" alt="DeepSeek × B.AI V4 Flash free tier" height="30"></a>

> **Donation transparency**: how much the community gives and where the tokens go should be public. I have not found a good way to build that yet. If you have ideas, open an issue and tell me.

## Background

Since 2025, attacks on the Agent toolchain keep surfacing: tool poisoning in MCP servers (malicious instructions hidden in tool description text, and the model is compromised the moment it reads them), rug pulls in plugin markets (a clean version builds install counts, then an update turns malicious), malicious Skills masquerading as popular projects, and prompt injection written into READMEs and instruction files.

Every one of these attacks exploits the same assumption: installation means trust. In the agent, mcp, skills, and plugins ecosystems, the code and instruction text you install runs with the host process's full privileges. It can read your keys, rewrite your prompts, and decide on behalf of your model.

DeepGuard works within limits. Static analysis cannot cover every runtime behavior, and AI judgment comes with false negatives and false positives. Every report states its audit boundaries up front.

Token budget limits the current audit firepower to the dsh ecosystem. The orchestration and skills are designed for the entire Agent toolchain. Coverage of the agent, mcp, skills, and plugins ecosystems will expand as budget allows.

## Detection framework

Three rule layers add up to 127 numbered rules (74 AI Agent security baseline, 30 dsh ecosystem overlay, 23 instruction-surface and backdoor rules), working alongside six detection dimensions, five defense layers in depth, dual AI review, and dispute arbitration. The full attack-surface model, dimension definitions, severity discipline, and automation design live on the security design page:

**<https://dsh.sober.report/intro.html>**

One working principle deserves a place here: **never trust the present, only trust snapshots**. Every report pins a plugin ID, a version, and a commit SHA. The market only shows install commands bound to a snapshot. A second commit appearing under the same version string means the version history may have been rewritten, and an alert fires. Resubmitting the same triple is rejected at the intake gate; a re-audit requires a version bump or new commits.

## Workflow

The full business chain from submission to listing. AI only drafts reports; every entry and exit passes a deterministic script gate:

<p align="center"><img src="https://dsh.sober.report/assets/diagrams/workflow.en.svg?v=1" alt="Workflow: submit → gate → Sonar → Aegis → (Beacon) → postcheck → publish → sync" width="620"></p>

## Architecture

Two-repo topology: this repo is the submission entry, the report authority, and the pipeline executor; the audit core, rulesets, and site live in the private core repo. Core code is delivered to this repo's pipeline via sparse checkout; reports flow back one-way through mirror PRs; the web layer is display-only:

<p align="center"><img src="https://dsh.sober.report/assets/diagrams/arch.en.svg?v=1" alt="Architecture: public repo and private core repo topology, delivery and one-way flow" width="860"></p>

## Usage

### Submitting a plugin

Use the "Plugin Audit Submission" Issue Form in this repo. The template applies the `audit-submission` label; issues without it never enter the pipeline.

- **Who can submit**: only the plugin author — the repository owner, verified automatically against GitHub server-side data; self-declaration does not count, and the whitelist is an internal fast-track channel. In the AI Agent era everyone is a creator, and a creator answers for the safety of their own work. Submitting for audit is how you vouch for your product.
- **Account requirements**: the intake gate is pure scripting, so a rejection costs no audit resources. It checks author identity, GitHub account age, whitelist (fast-track), blacklist, and the one-audit-per-triple rule (plugin, version, commit). Fresh throwaway accounts and blacklisted identities get rejected on the spot.
- **After submission**: once pre-screening passes, the plugin enters the queue and gets audited. The verdict is posted back to the source issue, which is then closed. Passing reports enter the market index; failing ones stay unpublished, the queue entry is marked needs-human for extended review, and a human steps in for special cases.

**For agents**: was this plugin built by an AI agent? Hand it the prompt below and it will file the listing application when the build is done:

```text
When this project is finished, submit it for a DeepGuard security audit and market listing:
1. Make sure the GitHub repository is public and fully pushed (pre-screening pins the HEAD commit).
2. Open this URL in a browser (replace the bracketed values and URL-encode them; category is one of: UI Extension (ui) / Tools (tools) / Sandbox / Execution (sandbox) / Bridge (bridge) / Model Adapter (model) / Workflow (workflow) / Memory (memory), or Uncertain):
   https://github.com/SoberReport-AI/DeepGuard/issues/new?template=plugin-submission.yml&title=[Audit]%20<plugin name>&name=<plugin name>&repo=<repo root URL>&category=<category>&notes=<optional notes>
3. On the form page, tick Declared Capabilities to match the plugin's actual runtime behavior, tick all three Submission Confirmations, and submit.
4. Watch the issue: the pre-screening result and the audit verdict are posted back as comments. One audit per version + commit; bump the version or push new commits before resubmitting.
```

### Rules

Two red lines, both enforced by deterministic scripts with no AI discretion:

1. **Malicious spam submissions.** Sockpuppet floods, resubmitting the same snapshot, forged identity. The gate blocks them and blacklists the submitter.
2. **A plugin confirmed to contain a malicious backdoor or poisoning.** The blocked-verdict report is published as-is, the author and associated identities (organizations, maintainers) are cascade-blacklisted, and the [advisories page](https://dsh.sober.report/advisories.html) broadcasts a takedown advisory.

The blacklist is public (`reports/_blacklist.json`). Nothing from a blacklisted identity is ever accepted again.

### An agent team

Four agents share the analysis, review, arbitration, and publication, with no human final review:

| Role | Responsibility |
|---|---|
| Sonar | Static audit; produces the report draft |
| Aegis | Independent second review; re-verifies every piece of evidence line-by-line, plus severity-inflation checks |
| Beacon | Convenes only when Sonar and Aegis disagree; picks one of three outcomes; cannot edit the report |
| Harbor | Pre-publication inspection; read-only contents, veto power only; covers attacks mounted through the release channel itself |

One iron rule: AI only drafts reports; every entry and exit passes deterministic hard gates. When any step is unsure, no PR is opened. The queue entry is marked needs-human for extended review, and a human steps in for special cases.

## Security Q&A

### Why are only plugin authors allowed to submit plugins?

Impersonating a developer to ship poison is one of the most common attack entries in open source. Requiring the author to submit, plus account-age and identity checks, raises the cost of attack from a zero-cost throwaway account to a real identity on the line. Attackers are not absolutely kept out, but once they act they leave an identity trail and get blacklisted, with no zero-cost retry. The second consideration is accountability. In the AI Agent era everyone is a creator, and a creator answers for their own product.

### Why DeepSeek V4 Flash as the base model?

After testing several models, DeepSeek V4 Flash fits this scenario (long-context code reading, structured output, high-frequency calls) and this cost structure best. Model capability is one side of it. The other side is encoding security domain knowledge into skills: rulesets, scenario libraries, and severity discipline are human priors, and the model works inside that framework. That combination carries the project's tasks.

### Can I fully trust the reports produced by the DeepGuard agent team?

No, and we do not promise otherwise. DeepGuard is an experimental project. Agents do the analysis, judgment, arbitration, and publication, so omissions and misjudgments are possible. We lay the uncertainty out in the open instead. Every report carries a full audit-boundary statement, every conclusion comes with evidence files and line numbers you can re-check one by one, and the correction channel stays open. Before installing any plugin, treat the report as a reference. The final call is yours.

### How long can this project be maintained?

As long as the token balance lasts. The project runs on an initial fund I topped up myself, and at the current audit pace it will run out. When that day comes, auditing stops; the published reports and all the code remain in the repository. If you want this agent team to keep going, you can [buy it more tokens on Ko-fi](https://ko-fi.com/G2S825CBZS). I am still looking for a transparent scheme where donations and token consumption are both publicly visible. Ideas welcome via issue.

## Repository layout

```
├── reports/                      # audit report library (data as code, hard-gate protected)
│   ├── _schema/                  #   report JSON Schema v3 (human-readable fields are {zh, en} bilingual objects)
│   ├── _blacklist.json           #   ecosystem blacklist
│   ├── _audit-log.json           #   audit ledger (machine-generated)
│   ├── _advisories.json          #   ecosystem advisory feed
│   ├── _identity.json            #   author verification / official plugin config
│   └── <plugin-id>/<version>/<commit>.json   # report body (immutable once merged)
├── _import/                      # collection & submission pre-screening
│   ├── catalog.json              #   plugin catalog (with stars)
│   ├── audit-queue/              #   audit queue
│   ├── whitelist.json            #   submitter whitelist
│   ├── watch-list.json           #   version-watch config
│   ├── batch-top20.json          #   batch dispatch manifest
│   ├── collect-plugins.js        #   collection script (pure script, no AI)
│   └── prescreen-submission.js   #   submission pre-screening script (pure script, no AI; same-triple rejection)
├── scripts/
│   ├── validate-report.js        # report hard-gate validation (schema v3 + semantic rules + bilingual completeness)
│   └── audit-log.js              # ledger generation
├── AUDIT-LOG.md                  # audit ledger (rendered output)
└── .github/workflows/            # audit orchestration: see the table below
```

## How to read a report

- One directory per plugin. The three path segments `reports/<id>/<version>/<commit>.json` equal `plugin.id/version/commit` inside the report, one to one.
- Once merged, a report is **immutable**. Corrections land as new revisions (`report_version` incremented) with history preserved. Version switching, `version_diff`, and rug-pull detection all depend on this.
- Same version with a different commit means two reports, and that is the material basis of force-push advisories.
- Human-readable fields (summary, finding descriptions, evidence notes) are `{zh, en}` bilingual objects. zh is the audit original; en comes from an independent translation role with deterministic verification (one-to-one field correspondence, conclusions cannot change).
- The format contract lives in `reports/_schema/deepguard-report.schema.json`. Every report must pass the `scripts/validate-report.js` hard gate to be merged.

## CI workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `issue-intake.yml` | issue labeled / edited | Pre-screen + enqueue + dispatch audit (only `audit-submission` labels on open issues) |
| `agent-audit.yml` | dispatch / manual | Main audit pipeline (gate → sonar → aegis → beacon → translate → publish → sync → ledger → issue-feedback) |
| `audit-dispatch.yml` | cron */10 + workflow_run fast path | Batch scheduling (fills the next slot in manifest order) |
| `watch-updates.yml` | cron | Version watch for admitted plugins (force-push / new-version alerts) |
| `validate.yml` | PR / push touching `reports/**` | Report hard-gate validation; FAIL blocks merging |

After a report merges here, a mirror PR syncs it to the private core repo: six deterministic gatekeeper checks plus Harbor final review, then auto-merge, index rebuild, and market deploy. A structured English receipt goes to the source issue before it closes. The mirror-side workflows do not live in this repo.

## Verdict quick reference

- **overall_result**: any CRITICAL dimension or rug-pull signal → `blocked`; findings without CRITICAL → `risk`; all clear → `clean`
- **Verdicts move only inside the dimension state machine**; no explanatory text downgrades a verdict
- **Reports are immutable once merged**; corrections ship as a new revision (`report_version` incremented)
- Rule-id references and finding descriptions in reports are conclusive public content; decision details, thresholds, and the full detection ruleset stay undisclosed

## Acknowledgments

Some plugin metadata in the market (names, descriptions, categories) comes from the community list [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Thanks to its maintainers for the curation.

## License

All content in this repo (report data + scripts + pipeline orchestration) is licensed under [PolyForm Noncommercial 1.0.0](LICENSE): personal research, learning, and testing are permitted, as is use by nonprofits, educational institutions, and government or public research bodies. Commercial use is prohibited. Contact the author for commercial licensing.
