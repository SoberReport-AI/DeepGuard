# Security Policy

## Scope

This repository is DeepGuard's public report repo (report data + audit pipeline orchestration). Detection rules, the audit agent implementation, and the frontend presentation layer are closed-source and are not part of this repo.

## Reporting Security Issues

- **Report data errors** (an audit report is wrong, a verdict is questionable): please open an Issue, noting the plugin id / version / commit and the specific problem.
- **Vulnerabilities in the pipeline or this repo's code**: please open an Issue describing the trigger path and impact.
- **Audit-capability bypasses** (you found a technique that evades detection): please do **not** disclose details publicly; send them to the security email (TODO: fill in before launch), and we will prioritize them.

## Response Commitments

- Data/verdict issues: once confirmed, corrected by publishing a new revision report (historical reports are immutable).
- Pipeline vulnerabilities: once fixed, the fix is documented publicly in this repo.
