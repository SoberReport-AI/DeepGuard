## ⚠️ DeepGuard Audit Interrupted: Provider-Side Error

**Status:** `interrupted` · **Category:** `{CATEGORY}`

---

### What happened

The audit was interrupted by an LLM provider error that could not be recovered automatically. **This is an operations-side issue, not a problem with your submission** — no action is required from you.

### Details

| Item | Value |
|---|---|
| Plugin | `{PLUGIN_ID}` |
| Repository | {REPO_URL} |
| Version / Commit | `{VERSION}` / `{COMMIT}` |
| Endpoint / Model | {ENDPOINT} / `{MODEL}` |
| Failed stage | `{ROLE}` |
| HTTP status | `{HTTP_STATUS}` |
| Retries | {RETRY_INFO} |
| Time (UTC) | {TIMESTAMP} |

### What happens next

- This issue **stays open**; the audit will be re-dispatched once the provider condition clears.
- If this state persists, a maintainer will investigate the endpoint configuration.

<details>
<summary>Raw error (truncated)</summary>

```
{ERROR_DETAIL}
```

</details>
