## ⛔ DeepGuard Audit Result: Submission Prerequisite Not Met

**Verdict:** `rejected` · **Reason:** `invalid-submission`

---

### What happened

The audit could not start: this submission does not satisfy a hard prerequisite of the audit pipeline. The check is deterministic and ran before any analysis began — no audit report was produced.

### Details

| Item | Value |
|---|---|
| Plugin | `{PLUGIN_ID}` |
| Repository | {REPO_URL} |
| Version / Commit | `{VERSION}` / `{COMMIT}` |
| Failed stage | `{ROLE}` |
| Reason | `{ERROR_DETAIL}` |

### How to resubmit

1. Fix the prerequisite listed above (for example, add a `version` field in semver `x.y.z` format to the plugin's `package.json`).
2. Push the changes, then edit this issue or open a new submission.

> **Note:** This is a deterministic property of the submitted snapshot, not a transient failure — re-running the same snapshot will produce the same result.
