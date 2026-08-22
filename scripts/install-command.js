#!/usr/bin/env node
/**
 * DeepGuard install command mechanical assembly (single source of truth, pure function, zero dependencies)
 *
 * market.install_command must never be agent-generated: the publish layer (build-index.js, when
 * copying reports) always overwrites it with this function's output. All assembly inputs come from
 * schema-locked structured fields:
 *   source.url  → owner/repo (schema restricts to https://github.com/<owner>/<repo>)
 *   commit      → #<sha> (contract locks the full 40-char lowercase hex; short hashes rejected)
 *   subpath     → &path:<subpath> (monorepo only; null/absent = repository root)
 *   verdict     → returns null when blocked (distribution frozen, no install path offered)
 *   _meta.json profile → profile override: a string overrides the default 'web'; false omits --profile
 *
 * Output shape:
 *   repository root : dsh plugin --profile web add github:<owner>/<repo>#<commit>
 *   monorepo subdir : dsh plugin --profile web add github:<owner>/<repo>#<commit>&path:<subpath>
 * The &path: fragment parameter is the pnpm git-dependency syntax for installing from a repository
 * subdirectory (pnpm v9+; multiple fragment parameters are joined with &). dsh delegates github:
 * specs to pnpm, so the root-only splice installs the WRONG tree for monorepo plugins — the subpath
 * must ride along or the command is broken by construction.
 * Returns null whenever any input violates the contract (defensive fallback; unreachable with normal data).
 *
 * commit must be the full 40 chars; short hashes are rejected: a short-prefix collision takes only
 * ~2^16 attempts (minutes on a GPU). After an author force-pushes the original commit away, a malicious
 * commit with the same prefix can silently take its place — exactly the rug pull scenario, and the
 * entire point of locking is unforgeability. Display layers may truncate; the lock must be full-length.
 *
 * subpath is accepted only as a POSIX relative path of safe segments (no leading/trailing slash, no
 * `..`, no fragment/query characters). An invalid subpath fails closed → null (no command offered):
 * a guessed command is worse than none, and the SEC-005 equivalence gate calls this same function,
 * so agent-written reports and the gate can never disagree about the legitimate value.
 */
'use strict';

// one or more POSIX segments of safe charset; `..` is rejected separately (it matches this charset)
const SUBPATH_RE = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

function normalizeSubpath(v) {
  if (v == null) return null;
  const s = String(v);
  if (s.length > 200 || !SUBPATH_RE.test(s) || s.split('/').includes('..')) return undefined; // invalid → fail closed
  return s;
}

function buildInstallCommand(rpt, meta) {
  if (!rpt || !rpt.plugin) return null;
  if (rpt.summary && rpt.summary.overall_result === 'blocked') return null;
  const url = String((rpt.plugin.source && rpt.plugin.source.url) || '');
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const commit = String(rpt.plugin.commit || '');
  if (!/^[0-9a-f]{40}$/.test(commit)) return null;
  const subpath = normalizeSubpath(rpt.plugin.subpath);
  if (subpath === undefined) return null; // invalid subpath: fail closed, offer no command
  const profile = meta && meta.profile === false
    ? null
    : (meta && typeof meta.profile === 'string' && meta.profile.trim()) || 'web';
  const fragment = subpath ? `#${commit}&path:${subpath}` : `#${commit}`;
  return `dsh plugin${profile ? ` --profile ${profile}` : ''} add github:${m[1]}/${m[2]}${fragment}`;
}

module.exports = { buildInstallCommand };
