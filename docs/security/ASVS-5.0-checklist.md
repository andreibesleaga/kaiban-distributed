# OWASP ASVS 5.0 — Control Mapping

> Maps the relevant **OWASP Application Security Verification Standard 5.0** domains to
> the controls implemented in kaiban-distributed. Status: ✅ implemented · 🟡 partial /
> deploy-dependent · N/A not applicable · ⬜ future. This is a self-assessment, not a
> certification (see [SECURITY.md](../../SECURITY.md)). ASVS 5.0: https://owasp.org/www-project-application-security-verification-standard/

| ASVS domain | Applicable requirement | Control | Status |
|-------------|------------------------|---------|--------|
| **Validation & sanitization** | Validate all untrusted input | `a2a-connector.ts`: `agentId` ≤64 `/^[\w-]+$/`, `instruction` ≤10 000 chars; rejects `*`; W3C `traceparent` regex-validated before use (`bullmq-driver.ts`) | ✅ |
| **Validation & sanitization** | Output/state minimization | `sanitizeDelta()` strips PII keys (both state paths); `result` cap 20 KB; outbound cap 64 KB | ✅ |
| **Authentication** | Authenticate privileged endpoints | JWT (HS256) on A2A RPC (`a2a-auth.ts`) and board Socket.io (`board-auth.ts`); **env-gated** (off by default → opt-in) | 🟡 |
| **Session management** | Bound token lifetime | Board token 3600 s; A2A token 86400 s; signed + verified server-side | ✅ |
| **Authorization / access control** | Restrict by role/identity | Agent-card capabilities; gateway routes; rate limits per IP (100/60 s RPC, 5/60 s health) | 🟡 |
| **Cryptography** | Strong, standard primitives | HMAC-SHA256 channel signing with `timingSafeEqual` + 30 s replay window (`channel-signing.ts`); SHA-256 id hashing; mTLS for Redis/Kafka | ✅ |
| **Error handling & logging** | No sensitive data in logs; audit trail | SHA-256 hashed agent ids in logs; run-logger decision trail; OpenTelemetry spans; W3C traceparent across hops | ✅ |
| **Data protection** | Minimize & protect sensitive data | PII denylist sanitization; size caps; secrets via env only (never logged) | ✅ |
| **Communications security** | Encrypt in transit | mTLS (`REDIS_TLS_*`, `KAFKA_SSL_*`); HTTPS to LLM APIs; `TLS_REJECT_UNAUTHORIZED` default true | 🟡 |
| **Malicious input / agentic** | Prompt-injection defense | `HeuristicFirewall` (10 patterns, opt-in) + optional LLM deep-analysis; firewall verdict routes to DLQ | ✅ |
| **Resilience / availability** | Prevent cascading failure / DoS | `SlidingWindowBreaker` (threshold 10 / 60 s window); per-task timeout (5 min); `MAX_TOKEN_BUDGET` | 🟡 |
| **Configuration** | Secure defaults; fail-fast | `loadConfig` validates + `requireEnv("AGENT_IDS")`; security features default OFF (backward-compatible); non-root container | ✅ |
| **API & web service** | Hardened HTTP surface | Helmet (CSP/HSTS), request timeout 30 s, 1 MB frame cap, CORS via `SOCKET_CORS_ORIGINS` (required in prod) | ✅ |
| **Supply chain** | Dependency & build integrity | CI: `npm audit` (blocking HIGH+), OSV, gitleaks, CodeQL, CycloneDX SBOM; releases: SLSA provenance + Sigstore signing | ✅ |
| **Self-protection** | Rate limiting / quotas | Per-IP rate limits; per-agent token budget; **global cross-agent rate limit** | ⬜ future (v2 safety) |
| **OAuth / OIDC** | — | Not an OAuth provider/consumer | N/A |

## Notes
- Auth/transport rows are **🟡 deploy-dependent**: the controls exist but are env-gated, so the deploying operator must enable them (secrets set) for full enforcement.
- The single ⬜ item (global cross-agent rate/cost limiter for massive fan-out) is tracked as a v2 safety feature.
- OWASP LLM Top 10 (2025) and Agentic Applications Top 10 (2026, ASI01–ASI10) mappings are in [SECURITY_FEATURES.md](SECURITY_FEATURES.md).
