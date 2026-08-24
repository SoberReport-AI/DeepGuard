## ⚠️ DeepGuard Audit Interrupted: Provider Content Moderation

**Status:** `extended review` · **Category:** `{CATEGORY}`

---

### What happened

The LLM provider's content moderation terminated the audit mid-run (`finish_reason: content_filter`). Moderation fires on the raw token stream of the audited snapshot, so re-running the **same snapshot** on this endpoint will almost certainly hit the same refusal — this is a deterministic property of the submission content, not a transient outage.

**This is not a security verdict on the plugin.** The audit simply could not complete on the current endpoint. A typical trigger is text the plugin ships for legitimate purposes (e.g., defensive filter wordlists) that trips provider-side moderation when read verbatim.

### Details

| Item | Value |
|---|---|
| Plugin | `{PLUGIN_ID}` |
| Repository | {REPO_URL} |
| Version / Commit | `{VERSION}` / `{COMMIT}` |
| Endpoint / Model | {ENDPOINT} / `{MODEL}` |
| Failed stage | `{ROLE}` |
| Retries | {RETRY_INFO} |
| Time (UTC) | {TIMESTAMP} |

### What happens next

- This issue **stays open** and the queue entry is flagged for **extended review**; a maintainer will inspect which content triggered the moderation and decide the disposition.
- Possible outcomes: maintainer rules the snapshot auditable after content adjustment by the author (resubmit a new version), a future endpoint without provider-side moderation, or a manual audit.

> **Note for authors:** if your plugin ships filter wordlists or sample attack/abuse text, consider loading such data from a remote config at runtime instead of embedding it verbatim in the repository — and expect runtime-loaded data to be reviewed for opacity in turn.

<details>
<summary>Raw error (truncated)</summary>

```
{ERROR_DETAIL}
```

</details>
