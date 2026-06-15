# 100% Verification Matrix — Doc↔Code, Examples & Deployment

> Phase 2 of the audit. Every concrete claim/instruction in the docs and every example/deployment
> artifact was verified against the real source. Status: ✅ FIXED (this engagement) · ⬜ PENDING ·
> ✔️ VERIFIED-CORRECT. Line numbers are from the audited HEAD; absolute paths under repo root.

## Legend & method
Four parallel read-only sweeps: **2A/2B** doc↔code (every claim, env var, endpoint, channel, snippet, constant); **2C** examples + 8 deployment targets; cross-checked against source. Docker not runnable during the sweep → deployment verified by static cross-reference.

---

## P0 — correctness / will-break-a-user

| # | Location | Issue | Status | Fix |
|---|----------|-------|--------|-----|
| P0-1 | k8s `examples/*/infra/kubernetes/agents.yaml`, helm `infra/helm/templates/agents.yaml` | Worker Deployments have `livenessProbe`/`readinessProbe` on `httpGet /health:3000`, but worker nodes start **no HTTP server** → pods never ready → CrashLoopBackOff; entire agent fleet down on `kubectl apply`/`helm install` | ⬜ | Remove HTTP probes from worker pods (per-role `.yml` already omit them) or use exec/TCP probe |
| P0-2 | k8s `examples/global-research/infra/kubernetes/agents.yaml` vs per-role `*.yml` | `agents.yaml` **duplicates** the per-role Deployments+HPA with conflicting content (probes); README says apply the whole dir → both land with same `metadata.name`, apply-order picks the broken one | ⬜ | Keep one source of truth (delete `agents.yaml` or the per-role files) |
| P0-3 | `docs/deployment/{AWS,AZURE,GCP}.md` gateway services | Gateway deployed without `AGENT_IDS`; `loadConfig()` calls `requireEnv("AGENT_IDS")` first → gateway crashes at startup | ⬜ | Add `AGENT_IDS=gateway` to each gateway service env |
| P0-4 | `docs/deployment/VERCEL.md:42-53` | Phantom steps: `cp -r examples/shared/viewer …` + `board-base.js`; none exist (viewer is self-contained 3 files) → step unrunnable | ⬜ | Delete Step 2 |
| P0-5 | `docs/deployment/VERCEL.md:113-116` | Tells users to set `CORS_ORIGIN`; real var is `SOCKET_CORS_ORIGINS` (required in prod or gateway throws) → Socket.io blocked | ⬜ | Use `SOCKET_CORS_ORIGINS` |
| P0-6 | `EXAMPLES.md:484-485` | `import { BullMQDriver } from 'kaiban-distributed'` — `package.json main:"index.js"` doesn't exist, no `exports` → bare import fails | ⬜ | Use deep subpath imports OR add a real barrel + `main`/`exports`/`types` (open Q1) |

## P1 — real bugs / misleading core claims

| # | Location | Issue | Status | Fix |
|---|----------|-------|--------|-----|
| P1-1 | `examples/global-research/phases.ts:213,216` | Editorial score parsed with label `'Compliance'` but editor emits `Accuracy Score` → score always "N/A" | ✅ FIXED | Changed to `'Accuracy'` + regression test asserting `result.score` |
| P1-2 | `vitest.config.mts` | `coverage.{lines,…}:100` mis-keyed for vitest 4 (not under `thresholds`) + no `all`/`include` → "100% coverage" measured only imported files, gate not enforced; real all-`src` cov was 95% (`main/index.ts` 0%) | ✅ FIXED | `coverage.all:true`+`include:['src/**']`+`thresholds:{…}`; added `tests/unit/main/index.test.ts`; now genuinely 100%, enforced |
| P1-3 | `package.json` `lint:arch` | `madge --circular src/` scanned **0 files** (no `--extensions ts`) → false-green arch gate | ✅ FIXED | `madge --circular --extensions ts src/` (now scans 41) |
| P1-4 | README badge + README:840,854, EXAMPLES.md:424, ADR-001:40 | Test count stale in 4 places (482 / 358 / 113); real ≈ **751** unit (+140 board) | ⬜ | Use real number consistently or drop hard counts; CI enforces it |
| P1-5 | `docs/security/SECURITY_FEATURES.md:385`, README:824, `docs/api/SPEC.md:219` | "result capped at **800 chars**"; code `MAX_RESULT_LEN = 20_000` (`agent-state-publisher.ts:37`) | ⬜ | Change 800 → 20,000 in all three |
| P1-6 | `SECURITY_FEATURES.md:300`, README:828 | Circuit breaker "emits OTLP `recordAnomalyEvent()`" — breaker only `console.warn`s; `recordAnomalyEvent` (telemetry.ts:42) called **nowhere** in src | ⬜ | Either wire `recordAnomalyEvent` into the breaker (observability win) or correct the doc |
| P1-7 | `KAIBANJS_INTEGRATION.md:298-321`, SPEC.md:170, README:576-583 | "Mode B" `new KaibanTeamBridge({...}, driver)` example **won't run**: real ctor is `(config, middleware?)`; a driver lacks `attach/disconnect`; class is `@deprecated` | ⬜ | Show `new DistributedStateMiddleware(redisUrl)`; note deprecation |
| P1-8 | `KAIBANJS_INTEGRATION.md:38,1618`, README:250, ACTOR_MODEL.md:66 | "**exponential** backoff" — code is **linear** `100ms × attempt` (`AgentActor.ts:149`) | ⬜ | "linear backoff (100 ms × attempt)" |
| P1-9 | `SECURITY_FEATURES.md:24,366-375` (PII) | `sanitizeDelta()` (9 PII keys) lives only in `DistributedStateMiddleware`, **not** in `AgentStatePublisher` — the path worker nodes actually use → board deltas from workers are **not** PII-filtered | ⬜ | Apply sanitization in `AgentStatePublisher` (security win) or scope the claim precisely |
| P1-10 | `docs/deployment/AWS.md:102` | ECS "worker" services reuse default `CMD` (gateway) → boot gateway, crash on missing `AGENT_IDS`; no per-worker command override / `REDIS_URL` / LLM key | ⬜ | Document per-worker command override + env |
| P1-11 | k8s/helm/AWS/AZURE/GCP manifests+docs | `GATEWAY_PORT` used everywhere but code reads `PORT` (`config.ts:92`) — dead var; 8080 examples break | ⬜ | Replace `GATEWAY_PORT` → `PORT` |

## P2 — accuracy / polish (representative; full list below)

| # | Location | Issue | Status | Fix |
|---|----------|-------|--------|-----|
| P2-1 | `SECURITY_FEATURES.md:280` | Firewall verdict doc `{blocked:true}`; real shape `{allowed:false,reason}` (pattern **count 10 is correct**) | ⬜ | Fix verdict shape in doc |
| P2-2 | root `docker-compose.yml:56` vs `SECURITY_FEATURES.md:425` | Doc says `KAFKA_AUTO_CREATE_TOPICS_ENABLE:"false"`; compose has `"true"` | ⬜ | Reconcile (recommend `"false"` for prod-accuracy) |
| P2-3 | `ACTOR_MODEL.md:233` | "circuit breaker open (5 failures)"; default is **10** (`CIRCUIT_BREAKER_THRESHOLD`) | ⬜ | 5 → 10 |
| P2-4 | `src/shared/README.md:63` | Env `CIRCUIT_BREAKER_TIMEOUT`; real `CIRCUIT_BREAKER_WINDOW_MS` | ⬜ | Rename |
| P2-5 | `SECURITY_FEATURES.md:65` | `BOARD_JWT_EXPIRY` documented but never read (arg only) | ⬜ | Remove or wire |
| P2-6 | README config table | `AGENT_TIMEOUT_MS`, `MAX_TOKEN_BUDGET` omitted; `ANTHROPIC/GOOGLE/MISTRAL/GROQ_API_KEY` honored (`kaiban-agent-bridge.ts:52`) but undocumented | ⬜ | Document them |
| P2-7 | README:711,928,933, Components table | References deleted `examples/blog-team/{driver-factory,build-security-deps}.ts` (moved to `src/shared/`) | ⬜ | Update paths to `src/shared/` |
| P2-8 | SPEC.md:223, README:470 | `teamWorkflowStatus` enum missing `ERRORED` (handled in `SocketGateway.ts:72`) | ⬜ | Add `ERRORED` |
| P2-9 | `BLOG_TEAM_TEST.md:166,200,221` | Phase wait times "45s/60s/45s"; real defaults 120/240/300s (`phases.ts:22-24`) | ⬜ | Correct |
| P2-10 | `.env.example:122`, global-research/README.md:67 | `SEARCHER_ID` "default searcher"; code auto-assigns `searcher-N` via Redis INCR | ⬜ | "Default: auto-assigned `searcher-N`" |
| P2-11 | `docs/deployment/HELM.md:40` | `image.tag:"latest"` but chart default `tag:""`→AppVersion `0.1.0` → ImagePullBackOff | ⬜ | Document real default / `--set image.tag` |
| P2-12 | `examples/blog-team/infra/helm/templates/gateway.yaml:26` | Gateway pod has only `configMapRef`, no `secretRef` → no LLM key | ⬜ | Add `secretRef` to envFrom |
| P2-13 | `scripts/blog-team.sh:137`, `run-example.sh:302` | Local orchestrator uses `npx ts-node` but `ts-node` not a declared dep | ⬜ | Add `ts-node`/`tsx` devDep or run compiled `dist/...` |
| P2-14 | ADR-003:24 | "cost direct from `WorkflowResult.stats`, no extraction hacks" — cost is computed locally via `MODEL_PRICING` (tokens from stats) | ⬜ | Clarify cost is computed from token stats |
| P2-15 | RAILWAY.md, GCP.md, KUBERNETES.md, DOCKER.md | Stale Dockerfile snippet; `railway.json services[]` unsupported; Cloud Run worker CPU-throttle caveat; broken anchors; `cli-only` profile note | ⬜ | Per-file doc fixes |

**Examples verdict:** blog-team ✅ OK · global-research ✅ OK after P1-1.
**Deployment verdict:** DOCKER ✅ · KUBERNETES/HELM/AWS/AZURE/GCP/VERCEL ⬜ (need the P0/P1 doc+manifest fixes above) · RAILWAY mostly OK.

## Verified-correct (no action) — high-signal sample
Channel names (`channels.ts`), A2A endpoint surface + envelope, rate limits (100/60s rpc, 5/60s health), request timeout 30s, agentId validation (64, `/^[\w-]+$/`), JWT board/a2a (HS256), channel signing HMAC-SHA256 + 30s replay + `timingSafeEqual`, 64 KB cap (`65_536`), SHA-256 8-char id hash, traceparent regex, 3× retry, 5-min timeout, 15s heartbeat, firewall **10** patterns, MCP client surface, all 5 ADRs' core decisions, dev scripts. Full per-item table preserved in git history of the four sweep reports.
