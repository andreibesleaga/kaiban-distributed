# Book ↔ Code Consistency — `agentic-ai-manuscript` vs `kaiban-distributed`

> Phase 2G. `kaiban-distributed` is the **companion/reference code** for the book
> `/home/andrei/work/BOOK/agentic-ai-manuscript/` (publisher-bound; `PUBLISHER_COMPANION_CODE.md`
> maps it to **Chapter 9** "Global Research Swarm", with the distributed/MCP teaser in ch8 §8.8–8.9).
> Chapter 9's deep technical claims are **remarkably accurate**; divergences are concentrated in a few
> numbers, one string, OWASP annotations, and repo-metadata in `PUBLISHER_COMPANION_CODE.md`.
> Status per row: `book-should-soften` / `code-must-change` / `diverged` / `matches`.
> **Reconciliation direction is open question 9** (fix code vs edit the publisher-bound `.adoc`).

## Top divergences to resolve (prioritized)

| # | Book location | Statement | Code reality | Status | Note |
|---|---------------|-----------|--------------|--------|------|
| B1 | `PUBLISHER_COMPANION_CODE.md` (License) | "**License: MIT**" | `LICENSE` = **GPL-3.0**; `package.json:28`; README badge GPL-3.0 | **diverged** | **Highest legal risk for a Wiley title.** MIT≠GPL-3.0 (copyleft). Reconcile front-matter ↔ repo. |
| B2 | `PUBLISHER_COMPANION_CODE.md` (Reproducibility) | "Every dependency locked to exact version (**no `^`/`~`**)" | `package.json` has 29 `^` ranges | **diverged** | Lockfile reproducibility holds, but the literal "no ^/~" is false. Pin or reword. |
| B3 | `PUBLISHER_COMPANION_CODE.md` | "**Chapter 9 alone runs 850 tests**" | repo-wide ≈ **905** cases / 90 files (now 894 unit+board verified + e2e); README badge says 482 | **book-should-soften** | Three different numbers (850/482/905). Pick one accurate figure; CI will enforce it. |
| B4 | ch9 §9.7, Listing 9.6 / Table 9-6 | agent-card `description` = "Distributed AI agent swarm for research tasks" | `src/main/index.ts:110` = "Kaiban distributed agent worker node" | **diverged** | Verbatim listing ≠ real file. Align one side. (name/version/capabilities/endpoints match.) |
| B5 | ch9 §9.3 Pillar 3 / Table 9-9 | "Circuit Breaker → OWASP **ASI10**", "JIT Tokens → **ASI03**" | only `ASI01` annotated in code (`heuristic-firewall.ts:8`) | **book-should-soften** | Soften to "aligned with the ASI threat for rogue agents / identity abuse". |
| B6 | ch9 §9.3 Pillar 2 | crashed Searcher "BullMQ lock expires after the **configured TTL (30s)**" | no `lockDuration`/`30000` in src — 30s is the BullMQ library default, not configured here | **book-should-soften** | "the configured TTL" implies repo sets it; it doesn't. |
| B7 | ch9 §9.8.5 + §9.9.2 listing | "**800-character cap** for UI state events" | `agent-state-publisher.ts:37` `MAX_RESULT_LEN=20_000` | **diverged** | Same as doc finding P1-5; the book and three repo docs all say 800, code is 20 000. Reconcile globally. |

> **Note on firewall pattern count:** the book's "**10** regex patterns" is **correct** — `heuristic-firewall.ts` has exactly 10 (an earlier sweep miscounted 9). No action.

## Verified MATCHES (Chapter 9 is faithful)
Architecture layers & full component inventory at stated `src/...` paths; the five canonical channels + dash-naming ADR; `AgentActor` retry (`RETRY_ATTEMPTS=3`, `100×attempt`, DLQ, 64 KB, SHA-256 8-char); `createDriver`/`MESSAGING_DRIVER` factory + defaults; the entire Global Research Swarm example (Zara/Atlas/Sage/Morgan, maxIter 8/15, chaos 20% `process.exit(1)`, `node.ts` `NODE_TYPE` switch, fan-out/fan-in, HITL PUBLISH/REVISE/REJECT/VIEW); `docker-compose.kafka.yml` (cp-kafka 7.6.0, searcher replicas 4, resource limits); `rpc-client`/`CompletionRouter` listings; all security controls (JWT HS256, HMAC-SHA256 signing, 30s replay, `timingSafeEqual`, env var names); observability (15s heartbeat, 9-field PII strip in `distributedMiddleware`, W3C traceparent, OTLP, scripts); board 5 columns; LLM config priority; per-actor cost = real `tokens × MODEL_PRICING` (non-zero in saved runs). ch8 seven-state Kanban vs ch9 five-column board is internally consistent (book notes the simplification).

## Open items
- **B8** Repo-URL: ch9/README cite `github.com/andreibesleaga/kaiban-distributed`; front-matter cites the `agentic-ai-architectures` monorepo — ensure both resolve / cross-link.
- ch11/12/14/15 reference *other* companion projects (concierge-vendor, enterprise-telemetry, observable-agent, compliance-proxy) in the separate monorepo — out of scope for this repo.

**Recommendation:** B1 (license) and B2 (pinning) are the publisher-critical items; B4/B7 are verbatim-listing/number mismatches best fixed in code (cheap, additive) so the printed book stays correct; B3/B5/B6/B8 are book-side softenings. Await open-question-9 decision on whether I edit the `.adoc` files or hand you a redline.
