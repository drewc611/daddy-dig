# Security audit — daddy-dig — 2026-09-27

Part of a 22-repository audit of this account. The cross-repository report (method, pain points, business impact, solution analysis, roadmap) is published at https://claude.ai/artifact/KgdrC9eNyCwdqjvSfwMNuB.

## Summary for this repository

| Severity | Count |
|---|---|
| Medium | 2 |
| Low | 1 |

Automated passes run against this repository: gitleaks 8.24.2 (full history and tree), the placeholder-credential checker now shipped in `scripts/`, semgrep 1.178.0 (`p/security-audit`, `p/secrets`, `p/owasp-top-ten`, `p/github-actions`), bandit, pip-audit and npm audit where applicable, plus a manual review of auth, input handling, workflows and deployment files.

## Findings

| ID | Severity | Category | Location | Evidence | Impact | Fix | Status |
|---|---|---|---|---|---|---|---|
| DD-1 | Medium | Client can supply its own system prompt | `src/index.ts:116,520-525` | `VALID_ROLES` includes `system`; server prompt is only prepended when the client sends none | The persona and any guardrail in `SYSTEM_PROMPT` are bypassed; the endpoint becomes a free general LLM. | Reject or strip client `system` messages; always prepend the server prompt. | fixed (2f6b30d) |
| DD-2 | Medium | Rate limiter is per-isolate memory and trusts X-Forwarded-For off-platform | `src/index.ts:27,389-394,602-607` | Module-scope `Map`; `CF-Connecting-IP \|\| forwardedIp \|\| "unknown"` | Limit is effectively N× per colo and resets on eviction; unauthenticated Workers AI cost abuse. | Cloudflare rate-limiting binding or a Durable Object counter; drop the XFF fallback. | open: X-Forwarded-For fallback removed and optional `RATE_LIMITER` binding support added (2f6b30d). The limit stays per isolate until the owner adds a `ratelimits` binding with an account-unique `namespace_id` (README); Cloudflare counts per location, so a global cap needs a Durable Object |
| DD-3 | Low | Vulnerable dev dependencies | `package-lock.json` | npm audit (incl. dev): 13 High, 1 Critical (build tooling; 0 in prod deps) | Build-time only. | `npm audit fix`. | open: 1 critical + 13 high + 1 moderate reduced to 4 high + 2 moderate (4aae6be). The rest needs wrangler >= 4.143 (requires workers-types 5) and vitest 5, both major bumps |

## Guardrails added in this change

- `scripts/check-placeholder-secrets.sh` — fails the build on placeholder credentials, secret defaults, disabled-auth defaults, `debug=True`, literal secret assignments, private keys and committed `.env` files.
- `.gitleaks.toml` — gitleaks defaults plus custom placeholder rules and a fixture allowlist.
- `.github/workflows/secret-scan.yml` — runs both on every push and pull request and weekly over full history (SHA-pinned actions).
- `.pre-commit-config.yaml` — the same checks locally; run `pre-commit install` once.
- `docs/security/AI-CODING-GUARDRAILS.md` — the binding rules for any AI-assisted change, with references.
- A "Security rules for AI-assisted changes" section in `CLAUDE.md` (and `AGENTS.md` / Copilot instructions where present).
- `.gitignore` rules for `.env`, keys and Terraform state where they were missing.

See the cross-repository report for the fail-closed pattern by language and the prioritised fix list.
