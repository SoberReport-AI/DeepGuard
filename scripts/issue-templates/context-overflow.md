## ⛔ DeepGuard Audit Result: Context Limit Exceeded

**Verdict:** `rejected` · **Reason:** `context-overflow`

---

### What happened

The audit could not proceed: this submission exceeds the context limit of **DeepSeek V4 Flash on b.ai**, which the pipeline currently runs on (**b.ai free tier**).

### Details

| Item | Value |
|---|---|
| Plugin | `{PLUGIN_ID}` |
| Repository | {REPO_URL} |
| Version / Commit | `{VERSION}` / `{COMMIT}` |
| Endpoint / Model | {ENDPOINT} / `{MODEL}` |
| Failed stage | `{ROLE}` |
| Error | `{ERROR_DETAIL}` |

### How to resubmit

1. Shrink the audit surface (e.g. remove checked-in build artifacts, oversized data files, or vendored bundles from the plugin directory).
2. Push the changes, then edit this issue or open a new submission.

> **Note:** This is a deterministic limit of the free tier, not a transient failure — re-running the same snapshot will produce the same result.
