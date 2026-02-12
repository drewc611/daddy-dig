# Security Findings

Date: 2026-02-12
Scope: `/workspace/daddy-dig` (Cloudflare Worker backend + static frontend)

## 1) Rate-limit bypass via trusted `X-Forwarded-For` (High)

**What I found**
- The backend uses `X-Forwarded-For` as a fallback source for client identity when `CF-Connecting-IP` is absent.
- Because `X-Forwarded-For` is a user-controllable header in many deployment topologies, an attacker can spoof different values per request and evade rate limits.

**Evidence**
- `handleChatRequest` derives IP from `X-Forwarded-For` and feeds it into `checkRateLimit`.
- `handleAddressLookup` follows the same pattern.

**Why this matters**
- Attackers can rotate spoofed header values to avoid request throttling and generate uncontrolled LLM usage/cost.

**Recommendation**
- Only trust `CF-Connecting-IP` (or `request.cf` metadata) when running on Cloudflare edge.
- Ignore `X-Forwarded-For` unless it is injected by a known trusted proxy you operate.
- For stronger controls, move rate limiting to Durable Objects, Turnstile + token bucket, or Cloudflare-native rate limiting.

---

## 2) Request-body memory DoS risk from full buffering before size rejection (Medium)

**What I found**
- JSON bodies are read fully into memory with `request.arrayBuffer()` and only then size-checked.
- While there is a `Content-Length` check first, an attacker can omit or falsify the header and still force full buffering.

**Evidence**
- `parseJsonBodyWithLimit` immediately executes `await request.arrayBuffer()` and only then compares `byteLength` with `maxBytes`.

**Why this matters**
- Large or concurrent oversized requests can increase memory pressure and cause worker instability/latency degradation (application-level DoS vector).

**Recommendation**
- Enforce limits at the edge/WAF before worker execution.
- If feasible, use streaming body readers and stop once the limit is exceeded instead of fully buffering.
- Keep current `Content-Length` precheck, but do not rely on it as the only guardrail.

---

## 3) Prompt-injection persistence via acceptance of client-supplied `system` messages (Medium)

**What I found**
- Chat input validation allows client messages with role `system`.
- If any `system` message exists in client input, server does **not** prepend its own trusted system prompt.

**Evidence**
- `VALID_ROLES` includes `system`.
- `handleChatRequest` only prepends trusted system prompt when no `system` role exists.

**Why this matters**
- Any caller can provide a malicious `system` instruction and replace server policy/safety behavior.
- This is especially risky if the endpoint is later reused by trusted internal frontends or integrated into workflows assuming server-side policy enforcement.

**Recommendation**
- Reject client-provided `system` messages for untrusted callers.
- Always prepend a server-controlled system prompt and optionally append sanitized user/developer context separately.
- Consider signing frontend requests if differentiated trust levels are required.

---

## Additional observations (lower risk)

- In-memory rate limiter resets on worker restart and is per-isolate; this is weak for abuse prevention under distributed load.
- Client context includes `userAgent`, locale, and timezone; ensure this data sharing is acceptable under your privacy policy.
