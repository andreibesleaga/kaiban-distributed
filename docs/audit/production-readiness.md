# Production-Readiness Gate

> The whole system is assessed against general, distributed-systems, and agentic-AI
> production conditions. Anchored to: Google SRE Production Readiness Review,
> 12-Factor App, AWS Well-Architected, Deutsch's 8 Fallacies of Distributed Computing,
> OWASP LLM Top 10 (2025) + Top 10 for Agentic Applications (2026), NIST AI RMF.
> Status: ✅ Pass · 🟡 Partial/Gap · ⬜ Fix planned. Evidence in `src/` unless noted.

## General production

| Control | Status | Evidence / gap |
|---------|--------|----------------|
| 12-factor config (env) | ✅ | `src/main/config.ts` reads all config from env; `.env.example` documented |
| Fail-fast config validation | ✅ | `requireEnv("AGENT_IDS")` throws on boot; `parseMessagingDriver` validates |
| Secrets never in code/image | ✅ | env-only; full-history gitleaks scan clean; no `.env` ever committed |
| Structured logging + context | 🟡 | `shared/logger.ts`; logs carry actor/trace/task ids but are line-oriented, not JSON — consider structured JSON output |
| Metrics + SLI/SLO + alerting | 🟡 | OTel **tracing** wired; **no metrics** (queue depth, msg/s, p99) and no SLO/alert defs yet (planned: OTel meters) |
| Health/readiness/liveness | 🟡 | Gateway `/health` (+ readiness logic); **worker nodes expose no HTTP health** → k8s/helm worker probes misconfigured (verification P0-1) |
| Graceful shutdown (drain) | ✅ | `index.ts:139-148` SIGTERM/SIGINT → `actor.stop()` + `socket.shutdown()` + `driver.disconnect()`; per-task timeout bounds in-flight work |
| Resource limits / autoscaling | ✅ | compose/k8s set cpu/mem; HPA manifests present; BullMQ/Kafka competing-consumers scale horizontally |
| Zero-downtime deploy / rollback | ✅ | stateless workers + external broker → rolling updates safe |
| Container hardening | ✅ | non-root `USER`, multi-stage build; pin base image |
| Backup/DR for Redis/Kafka | ⬜ | Not documented — add an operations note (broker is the durability boundary) |
| Runbooks / on-call | 🟡 | `scripts/monitor.sh` + deployment docs; no incident runbook |
| Capacity / load testing | ⬜ | No `bench/` suite yet (planned: tinybench throughput-vs-workers) |

## Distributed-systems (8 fallacies + patterns)

| Control | Status | Evidence / gap |
|---------|--------|----------------|
| Timeouts everywhere | ✅ | per-task `DEFAULT_TASK_TIMEOUT_MS=300_000`; HTTP `req.setTimeout(30_000)` |
| Retries + backoff | ✅ | `AgentActor` 3× retry, **linear** 100ms×attempt (docs say "exponential" — P1-8) |
| Circuit breaker | ✅ | `SlidingWindowBreaker` (opt-in); default threshold 10 / 60s window |
| At-least-once + idempotency | 🟡 | BullMQ/Kafka at-least-once; DLQ on exhaustion; consumer idempotency relies on KaibanJS task semantics — document the guarantee |
| DLQ + poison-message | ✅ | failed tasks → `kaiban-events-failed`; `CompletionRouter` handles both |
| Backpressure / size caps | ✅ | 64 KB outbound cap; result cap 20 KB; queue concurrency bounded |
| Ordering / partitioning | 🟡 | Kafka consumer-group model; ordering per-key not asserted — document |
| Trace propagation across hops | ✅ | W3C traceparent inject/extract on **both** drivers (`TraceContext.ts`, `bullmq/kafka-driver`) — spec-correct |
| Eventual consistency / reconcile | ✅ | 15s heartbeat re-broadcasts state; board snapshot accumulation for late joiners |
| Graceful degradation (broker down) | 🟡 | reconnection via ioredis/kafkajs defaults; **no chaos/fault-injection test yet** (planned nightly: mid-flight broker kill) |
| Message integrity | ✅ | optional HMAC-SHA256 channel signing + 30s replay window |

## Agentic-AI (OWASP LLM/Agentic, NIST AI RMF)

| Control | Status | Evidence / gap |
|---------|--------|----------------|
| Prompt-injection defense (LLM01/ASI01) | ✅ | `HeuristicFirewall` 10 patterns (opt-in); optional LLM deep-analysis hook |
| Token-budget / cost control (LLM10) | 🟡 | per-agent `MAX_TOKEN_BUDGET`; **no global/rate limiter** across parallel fan-out — flag as v2 safety feature |
| LLM call timeout / fallback | 🟡 | task timeout bounds calls; no explicit model fallback chain |
| Output validation / guardrails | 🟡 | structured parsing of agent output; no schema-enforced output validation |
| HITL for high-stakes actions | ✅ | editorial review gate (terminal + board, first-to-respond) |
| PII minimization (LLM02) | 🟡 | `sanitizeDelta()` (9 keys) + SHA-256 id hashing — **but only on the DistributedStateMiddleware path, not AgentStatePublisher** (verification P1-9); close the gap |
| Tool/MCP least privilege (ASI02) | 🟡 | MCP stdio client; document tool allow-listing / sandboxing guidance |
| Per-call cost/token/latency observability | ✅ | economics panel + real `tokens × MODEL_PRICING`; tokens from KaibanJS stats |
| Agent-quality evals / regression | ⬜ | No eval harness for agent output quality (v2) |
| Runaway-loop protection | ✅ | circuit breaker + maxIterations + per-task timeout |
| Decision audit trail | ✅ | run loggers persist task/decision JSON; OTel spans |
| Inter-agent comms security (ASI07) | ✅ | channel signing + JWT on A2A/board surfaces |

## Verdict
**Strong distributed + security posture; the gaps are concentrated and additive-fixable.** Top production blockers to close before a "production-grade" stamp:
1. **Worker health endpoints** (P0-1) — fix k8s/helm probes (manifest) so workers can be orchestrated.
2. **PII sanitization on the worker state path** (P1-9) — apply `sanitizeDelta` in `AgentStatePublisher`.
3. **Metrics + SLO/alerting** — add OTel meters (queue depth, msg/s, p99) and a bench suite.
4. **Chaos/fault-injection test** — broker mid-flight kill asserting zero message loss (nightly).
5. **Global cost/rate limiting** for massive fan-out (v2 safety).
None requires a breaking change; all are `additive`/`internal-only`.
