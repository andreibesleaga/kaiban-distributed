# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Docs: audit of 29 Oct 2026 — install with `npm ci`, corrected code samples (`KaibanTeamBridge`, single-image example), current test counts, project tree, HTTP routes, release procedure and CI workflow table, licence and advisory status; no code change.
- Dependencies: @opentelemetry/auto-instrumentations-node ^0.79.0 (fixes GHSA-qqmp-wf37-98f9 in 8 instrumentations); the glob override is capped below 14.
- Fixed: the A2A agent card advertises only the JSON-RPC interface (`/a2a/rpc`); it no longer lists HTTP+JSON (`/a2a/rest`) and gRPC (`/a2a/grpc`), which the gateway does not serve.

## [2.0.2] — 2026-10-23

Follow-ups to 2.0.1 that fit a patch: no new channel, no change to a default. One additive public API
field (`AgentActorDeps.retryOnTimeout`).

### Fixed
- **Aborting a task also stops the KaibanJS team.** On a timeout, an actor stop or a shutdown the
  bridge calls `team.stop()` and rejects with the actor's non-retryable abort reason, instead of
  leaving `team.start()` running. The team stops at the agent loop's next step; an LLM call already
  in flight on a provider other than the OpenAI-compatible one is not cancelled mid-call. An
  already-aborted task builds nothing. Tasks run without a signal behave as before.
- **A multi-agent worker drains every agent before it exits.** 2.0.1 drained once per agent node,
  so in a worker running several agents the first node to finish exited the process while the
  others were still draining. Now one SIGTERM or SIGINT drains all nodes of the process together,
  then exits once (non-zero if any node failed to drain cleanly).
- **Telemetry is flushed before exit.** The worker (after its drain) and the gateway (last shutdown
  step) wait for one once-only flush, bounded to 3 s so a hung exporter cannot block exit. Ctrl-C
  now flushes too. The SDK's own SIGTERM listener stays in 2.0.x for processes without their own
  shutdown; in a worker or the gateway it stands down, so it cannot flush before the drain.
- **Kafka workers heartbeat while a task runs** (every 3 s), so a task longer than the ~30 s
  session timeout no longer gets its worker evicted from the group and the task re-run elsewhere.
  Heartbeat errors are logged, not thrown; session and rebalance timeouts are unchanged. A real
  rebalance can still deliver a task twice until consume-side dedup lands in 2.1.
- **Probe routes have one bucket per route:** `/health`, `/ready` and `/startup` each allow 120
  requests a minute per client, so one route's traffic cannot exhaust another's.

### Added
- **`RETRY_ON_TIMEOUT=true`** (default off; `1` also accepted): a timed-out task goes through the
  normal retry and back-off path, 3 attempts in all. A stop or a budget breach is never retried; the
  last timeout still dead-letters as `task_timeout` and counts once on the circuit breaker. The
  gateway's A2A wait grows to 3 × `AGENT_TIMEOUT_MS` plus back-off plus 5 s when it is on (so the
  worker's own `task_timeout` result arrives first), so set it the same
  on the gateway and every worker. A `WorkflowOrchestrator` `timeoutMs` or an example's wait is not
  scaled: raise it by hand. `AgentActorDeps` gains the optional `retryOnTimeout`.

### Security
- **Token role check:** `verifyBoardToken` and `verifyA2AToken` require the `role` claim their
  issue helpers already set (`board-viewer`, `a2a-client`), so a board token is refused on the A2A
  and MCP routes and an A2A token on the board socket, even when both secrets are equal. Tokens from
  `issueBoardToken` / `issueA2AToken` keep working; a hand-signed token must carry the matching
  role. Strict `iss`/`aud` checks remain planned for 2.1.

### Build
- **npm publishing uses npm trusted publishing (OIDC):** `publish-npm.yml` needs no `NPM_TOKEN`,
  runs on every non-prerelease version tag (the release event never fired, because `release.yml`
  creates the release with `GITHUB_TOKEN`) and by hand with `--ref vX.Y.Z`. It typechecks, lints
  and runs the unit suite with coverage thresholds before it publishes.

### Not in 2.0.2 (planned for 2.1)
- Operator stop command, pause and resume; board-operator role and `decidedBy` on HITL decisions with
  a run-time board token; strict `iss`/`aud`; consume-side dedup, completion routing across
  processes, durable DLQ; `team.stop()` for `kaiban-team-bridge`. See
  `docs/roadmap/V2.1-ROADMAP.md` §7.4.

## [2.0.1] — 2026-10-23

Critical fixes before the companion book's launch. Everything under this heading, including the
spend-cap work merged earlier (#155–#157), ships as 2.0.1. No public API change.

### Fixed
- **A stopped or timed-out task is not retried.** Before, stopping a worker aborted the call in
  flight and the retry loop ran it again (paid again during shutdown), and a timeout was retried
  twice with a fresh 5-minute timer. Now a timeout ends the task as `task_timeout` (counts one
  circuit-breaker failure) and a stop as `actor_stopped`; a stop during the back-off cancels the
  next attempt, and a task delivered while the actor drains is not run. Both codes are replayable.
- **`AGENT_TIMEOUT_MS` reaches the worker nodes** (it only bounded the gateway's wait; workers
  always used 5 minutes).
- **Worker nodes drain on SIGINT as on SIGTERM**, once per process even if both arrive.
- **Dead-letter records keep the task inputs**, so `replayDlq` re-runs the same task instead of an
  empty one. Inputs that would exceed the 64 KB cap are left out and the record is marked
  `_inputs_omitted`; replay skips such records, and records written before 2.0.1, as `inputs_missing`.
- **A failed task's error carries the reason** after the code (`Agent failed: <code> — <reason>`).
- **Orchestrator:** a step waiting for the first checkpoint load when `clear()` runs throws instead
  of dispatching after the reset; a saved spend value whose conversion throws counts as zero.
- **Probe routes no longer restart pods:** `/health`, `/ready` and `/startup` allow 120 requests a
  minute per client (was 5, below the Kubernetes probe cadence).

### Security
- **Production secrets:** with `NODE_ENV=production`, boot refuses unless `BOARD_JWT_SECRET`,
  `A2A_JWT_SECRET` and `CHANNEL_SIGNING_SECRET` are set, at least 32 bytes and distinct.
  `ALLOW_INSECURE_PRODUCTION=true` lets a missing secret through with a warning on every start; a
  short or repeated secret is never allowed. The error names the variable, never its value.
- **HITL decisions:** the `taskId` must match `^[A-Za-z0-9._:-]{1,200}$` before it becomes a Redis
  key; 10 decisions per 10 s per connection; the board token's subject is logged with the decision.

### Not in 2.0.1 (planned for 2.1)
- An operator stop command (task, workflow, node, fleet), pause and resume; KaibanJS `team.stop()`
  on abort; role checks on HITL decisions and control routes. See `docs/roadmap/V2.1-ROADMAP.md` §7.3.

### Changed
- **Spend caps are on by default with low ceilings** (roadmap §7.2 item 2 groundwork). When nothing
  is set: `MAX_WORKFLOW_COST_USD=0.50`, `MAX_TOKEN_BUDGET=200000` (per agent, i.e. per
  `AgentStatePublisher` in its worker process) and the new
  `MAX_TASK_TOKEN_BUDGET=50000` (per task, all attempts). One resolver (`resolveSpendCaps` in
  `src/shared/budget.ts`, also used by `loadConfig()` and `startAgentNode`) parses all four caps:
  the literal value `unlimited` (case-insensitive) is the **only** way to remove a cap; `0`,
  negative or non-numeric values now fall back to the default with one warning (previously `0`
  meant unlimited). `MAX_WORKFLOW_TOKENS` stays unlimited when unset. A ceiling binds when the total
  **reaches** it (`>=`).
- `AgentStatePublisher` checks both token caps **before** the handler runs: a task that finds its
  agent's or its own tally already at the cap is refused with zero LLM requests; the tally per
  `taskId` survives redeliveries (bounded to the last 1 000 tasks). New
  `AgentStatePublisherOpts.maxTaskTokenBudget`, `getTotalTokensUsed()`.
- `WorkflowOrchestrator` enforces the workflow ceilings in the runtime, not only in the example
  orchestrators: spend is accounted from every `runStep` result / `memoize` value (the structured
  handler-result shape, or a custom `spendOf`), `recordSpend()` accepts external totals, and once a
  ceiling is reached every further dispatch throws `BudgetExceededError` (`getStop()` returns
  `{ reason: "budget_exceeded", detail, totals }`, `onStopped` fires once). Default budget =
  `workflowBudgetFromEnv()`. Checkpointed steps still replay.
- `WorkflowOrchestrator` keeps the workflow spend across a resume: the running totals and the stop
  record (`reason`, `detail`) are saved with every checkpoint, in one reserved entry
  (`__workflow_spend__`, now refused as a step name) of the same record, and restored once when a
  fresh instance with the same `workflowId` first loads it. Replayed checkpointed steps are not
  charged again; spend fed in through `recordSpend()` is saved in the background too. A resumed run
  that is still at its cap stays stopped (no second `onStopped`); a larger cap lets it continue.
  Spend is now accounted **before** `store.save` in `runStep` and `memoize`, so a failed save can
  neither drop it nor let a retry pass the cap. Previously totals restarted from zero on resume.
  The persisted spend comes only from step results that carry usage (`inputTokens` /
  `outputTokens` / `estimatedCost`, or a custom `spendOf`) and from `recordSpend()`. The example
  orchestrators do neither (their memoized phase values carry no top-level `inputTokens` /
  `outputTokens` / `estimatedCost`; blog-team: `tokens` / `cost`; global-research: a context
  snapshot), so their persisted spend is zero: they enforce the budget with their own totals
  (`assertWithinBudget`; blog-team's reset on resume, global-research's restored from its
  snapshot) and clear the checkpoint on a budget stop — roadmap §7.4. A restored stop record carries the detail computed
  from the restored totals and the current budget. `clear()` now also resets the in-memory totals
  and the stop record, and the instance saves nothing more until a new step completes, so a late
  `recordSpend()` (or a step that was in flight) cannot re-create the deleted record; a
  checkpoint load still in flight is discarded (whether it succeeds or fails: a failure neither
  triggers a reload nor adds the saved spend a second time), and the delete runs in order with the
  saves. The reset happens when the saves queued before `clear()` have finished, so spend recorded
  between calling `clear()` and that point is reset too. A
  throwing `onStopped` callback is logged and ignored, so it cannot keep a paid step from being
  saved. Checkpoints
  written by this version contain the `__workflow_spend__` entry; an older 2.0.x reading one sees
  it as a completed step (`isResuming()` true, an extra row in a custom `CheckpointStore`), so
  clear the checkpoint before downgrading.
- Failed KaibanJS attempts (workflow ended BLOCKED) count against the token caps: the KaibanJS
  bridge throws the new `FailedAttemptError` (still retryable) with the attempt's token usage when
  `team.start()` resolves with a non-success status (KaibanJS 0.24.2 resolves BLOCKED when an
  LLM/provider error blocks the task), and `AgentStatePublisher.wrapHandler` adds that usage (a
  non-finite or negative count as 0, on the success path too) to the agent and task tallies before
  the failure propagates. When that reaches `MAX_TOKEN_BUDGET` or `MAX_TASK_TOKEN_BUDGET` it raises
  `BudgetExceededError` instead, so the actor makes no further paid retry (and, being
  non-retryable, records no circuit-breaker failure). Previously a failed attempt's tokens were not
  counted. Thrown attempts are still not counted: an ERRORED workflow makes `team.start()` reject
  with no usage. A timed-out or aborted attempt still counts when its handler finishes later, with
  a result or a BLOCKED failure, which can be after the retry has started, and a custom
  `TaskHandler` must throw `FailedAttemptError` for its failed paid attempts to count. When failed
  attempts reach a token cap, the `BudgetExceededError` keeps the original failure: its message
  (the DLQ record's `reason`) ends with `(failed attempt: <original message>)` and its `cause` is
  the `FailedAttemptError`; the DLQ `error` code is unchanged.
- One sanitiser (`cleanSpendAmount` in `src/shared/budget.ts`) cleans every spend number before it
  is counted or published: the publisher's token counts and success-path `estimatedCost` (the
  board's `tokens` / `cost`), `WorkflowOrchestrator` spend from `recordSpend()` and from any
  `spendOf` (custom or default `spendOfHandlerResult`), and the restored checkpoint spend. A
  non-finite or negative value counts as 0, so `NaN` can no longer switch the workflow cap off and
  a `-1` (or other negative) value can no longer lower the spend or reach the board.
- `BudgetExceededError` now extends the new `NonRetryableError` (`src/domain/errors`), carries a
  `reasonCode`, and `AgentActor.executeWithRetries` re-throws any `NonRetryableError` on the first
  attempt: one handler call, no breaker failure, one DLQ record with `error` = the reason code
  (`token_budget_exceeded`, `task_token_budget_exceeded`, `budget_exceeded`) and `reason` = the
  message. `replayDlq` skips the workflow (`budget_exceeded`) and per-task
  (`task_token_budget_exceeded`) breaches as poison; the per-agent breach
  (`token_budget_exceeded`) is replayable, because that tally is held in the worker process and
  resets on restart — it is not a property of the task. Previously a budget breach was retried twice more.
- `buildSecurityDeps()` logs a warning when `ECONOMICS_ENABLED=true`, because the deployed worker
  wires no fleet cost limiter (roadmap §2 / ADR-023).
- Example compose files default `MAX_WORKFLOW_TOKENS` to `unlimited` (was `0`).
- Documentation corrected to what the code does today (roadmap §7.2 table): `tasks/cancel` stops
  the gateway wait only; the kill-switch is per-process; no consume-side deduplication exists;
  `ECONOMICS_ENABLED` alone enforces nothing in the worker; the 415 / error-sanitisation rows were
  removed from `SECURITY_FEATURES.md`; global-research does not resume with a random `WORKFLOW_ID`;
  KaibanJS `team.stop()` can abort non-OpenAI providers but the bridge does not call it yet
  (`owned-llm.ts`, ADR-014). `SECURITY.md`: supported versions 2.x; open Dependabot advisories
  as of 2026-10-21 replace the "0 vulnerabilities" sentence.

### Fixed
- Token caps reach every worker: all worker services in the root `docker-compose.yml` and the
  example `docker-compose.yml` / `docker-compose.kafka.yml` files forward
  `MAX_TOKEN_BUDGET: ${MAX_TOKEN_BUDGET:-200000}` and
  `MAX_TASK_TOKEN_BUDGET: ${MAX_TASK_TOKEN_BUDGET:-50000}` (an `--env-file` value, `unlimited`
  included, was not passed into the containers). The orchestrator comments no longer say
  `0 = unlimited`.
- The global-research searcher runs with the token caps: it builds its publisher with the new
  `createAgentStatePublisher()` (exported from `kaiban-distributed/shared`, also used by
  `startAgentNode`) instead of an uncapped `new AgentStatePublisher(...)`. The
  `kaiban-distributed/shared` entry also exports the types `AgentInfo`, `AgentStatePublisher`,
  `AgentStatePublisherOpts`, `TaskHandler` and `MessagePayload` (additive). The root entry still
  exports `AgentStatePublisher`, whose `new AgentStatePublisher(url, info)` without opts applies
  no caps; workers should use `createAgentStatePublisher()`, which the root entry now exports too,
  with the types `AgentInfo` and `AgentStatePublisherOpts` (additive). The README and
  `docs/KAIBANJS_INTEGRATION.md` worker samples now use `startAgentNode` or
  `createAgentStatePublisher()`.
- Downstream note: `kaiban-distributed-examples` has its lockfile at 2.0.0, but its `^2.0.0`
  range accepts the next 2.x on a fresh install or a Dependabot bump; with that bump its worker
  services must forward `MAX_TOKEN_BUDGET` and `MAX_TASK_TOKEN_BUDGET`
  in their compose files (and its `MAX_WORKFLOW_TOKENS` defaults / `0 = unlimited` text change to
  `unlimited`), or its workers run at the 200000 / 50000 defaults.
- CI: `npm ci` failed in the Quality, Security and Docker jobs (and would have in the nightly,
  release and publish lanes) after the Dependabot updates of 2026-10-04: Dependabot writes the
  lockfile with npm 11, which omits optional nested entries (`typescript@5.9.3` under
  `filing-cabinet`, `ignore@7.0.12` under `@kaibanjs/workflow` and `kaibanjs`) that npm 10, bundled
  with Node 22, requires. The lockfile is rewritten with npm 10.9.8 (accepted by npm 10 and 11), and
  every workflow job and both Dockerfile stages now run `npm ci` with npm 11.17.0, the npm Dependabot
  uses, declared as `packageManager` in `package.json` and `board/package.json`. New
  `scripts/fix-lockfile.sh` (`npm run lockfile:check`, `npm run lockfile:fix`) proves or repairs both
  lockfiles for npm 10 and 11.

### Added
- `docs/roadmap/V2.1-ROADMAP.md` §7: the defects and gaps found by a code audit of `main`, each
  checked a second time against the code, ranked into a 2.0.1 patch release (work that cannot be
  stopped or is paid for twice, lost completions, dead-letter records without the task, insecure
  defaults, false documentation) and additions to the §6 control plane (node and fleet stop).
- `publish-github-packages.yml`: mirrors the Apache-2.0 library tarball (built by
  `scripts/pack-staging.sh`, no GPL text) to GitHub Packages as
  `@andreibesleaga/kaiban-distributed` on every version tag or by manual dispatch, so
  the npm package is listed in the repository "Packages" sidebar next to the ghcr.io
  image. npmjs.com stays the canonical registry; the committed `package.json` is
  untouched (the rename happens in the staging dir); already-published versions are
  skipped, never overwritten.

### Security
- Raised the transitive `overrides` security floors to clear every open HIGH advisory
  in the locked tree: `brace-expansion` >=5.0.8 (GHSA-3jxr-9vmj-r5cp,
  GHSA-mh99-v99m-4gvg), `fast-uri` >=4.1.1 (GHSA-v2hh-gcrm-f6hx,
  GHSA-4c8g-83qw-93j6), `js-yaml` >=4.3.0 <5 (GHSA-52cp-r559-cp3m) and `postcss`
  >=8.5.25 (GHSA-r28c-9q8g-f849). Also cleared the remaining moderates:
  `hono` >=4.12.32, `protobufjs` >=8.6.6, and `@modelcontextprotocol/sdk` 1.30.0 with
  `@hono/node-server` 2.0.12 (GHSA-frvp-7c67-39w9). `npm audit` now reports
  **0 vulnerabilities** at the root and in `board/`, and the Trivy image gate passes
  with no fixable CRITICAL/HIGH.

### Changed
- `ossf/scorecard-action` 2.4.3 → 2.4.4.

### Fixed
- CI: the `Upload OSV SARIF` step no longer fails with "Path does not exist:
  osv.sarif" when an earlier gate fails — it is now guarded on the file existing,
  so a failing audit reports one real error instead of two.

## [2.0.0] — 2026-06-22

Major release — breaking changes are documented in `MIGRATION.md`. Authoritative plan:
`KAIBAN-v2.0-MASTER-PLAN.md`.

### Added
- **A2A v0.3 federation** via `@a2a-js/sdk`: the gateway answers `message/send`,
  `message/stream` (SSE), `tasks/get`, `tasks/cancel` on `POST /a2a/rpc`; AgentCard v0.3
  (object `capabilities` + abilities in `skills[]`). (BETA.1, ADR-015)
- **MCP server** — first-party Model Context Protocol surface (Tools / Resources / Prompts /
  Elicitation) over Streamable HTTP. (BETA.2, ADR-017)
- **Resilience** — the single-active orchestrator is promoted to `src/shared` (reusable, published):
  Redis checkpoint/resume, liveness/readiness probes, graceful drain, DLQ replay. (BETA.2, ADR-018)
- **Economics / FinOps** — fleet-wide rate + cost control (token bucket + cost reservation),
  **default-off**. (BETA.3, ADR-019)
- **Governance Action Gate** — **default-off, non-bypassable when enabled**: hash-chained audit,
  policy-as-code, kill-switch; hot-path enforcement wired into `AgentActor`. (BETA.3, ADR-020/021)
- **Universal AMQP driver seam** — declared `amqplib` seam, unimplemented stub (coverage-excluded).
  (BETA.1, ADR-016)
- **`dispatchToAgent`** actor-mailbox primitive in `src/shared` (replaces the removed `tasks.create`
  RPC). _(The examples also gain a local `parseAgentCardSkills` helper to read v0.3 AgentCards — example
  code, not a published library export.)_
- **Workflow budget guard** (`MAX_WORKFLOW_COST_USD` / `MAX_WORKFLOW_TOKENS`) in both example
  orchestrators — checked between phases and before each revision; **graceful STOPPED on breach**
  (default `0.50` in the example compose files; `0` = unlimited; separate from per-agent
  `MAX_TOKEN_BUDGET`).
- **Playwright visual baselines** for the React board + the two static example viewers
  (`cd board && npm run test:visual`).
- **`scripts/smoke-consumer.sh`** — packs the Apache tarball and verifies a fresh consumer can import
  the public surface from both entry points (`.` and `./shared`).
- **Packaging:** `./shared` subpath export + two-entry api-extractor; staging-dir `npm pack`
  (Apache-only artifact, no GPL leak). (BETA.1, ADR-011)
- **COMPLIANCE** cross-walk and the **v2.1 roadmap**.

### Changed
- **License (BREAKING):** the published npm library is now **Apache-2.0** (was GPL-3.0); the full
  application / board / examples remain **GPL-3.0** (dual-license — see `LICENSING.md`, ADR-011).
- **Dependencies:** KaibanJS 0.24.2, TypeScript 6.0, OpenTelemetry 0.219/0.77, bullmq 5.79, dotenv 17
  — all latest stable, **0 vulnerabilities** (ADR-012).
- **gateway / worker ROLE split** — a single image runs as `ROLE=gateway|worker`. (BETA.1, ADR-013)
- **AbortSignal cancellation** — an in-flight LLM call is aborted on task timeout and worker
  shutdown (the bridge owns the LLM instance). A2A `tasks/cancel` stops the gateway wait only; the
  worker runs to its timeout. (BETA.1, ADR-014; sentence corrected 2026-10-21, roadmap §7.2)
- **Examples migrated to A2A v0.3** — removed all `tasks.create` / `tasks.get` / `agent.status`
  usage; both examples dispatch via `dispatchToAgent` and read AgentCard `skills[]`.
- **Gateway HITL delivery** — the durable per-task BRPOP-list write now precedes the pub/sub
  publish, and the board is ACK'd only after **both** succeed (a missed pub/sub message stays
  recoverable via the list fallback).
- **`CompletionRouter` subscribes lazily** (on the first `wait()`) — a router that never waits no
  longer consumes the shared completed queue (fixes a competing-consumer hang between the gateway's
  A2A-executor router and an orchestrator router).
- **Kafka driver** now throws a clear error on a 2nd `subscribe()` (explicit one-topic-per-driver
  contract) instead of silently breaking.
- **BullMQ driver** sets job-retention defaults (`removeOnComplete` / `removeOnFail`, bounding Redis
  growth) and registers a worker `error` listener.
- **A2A executor** logs the underlying error server-side on failure (the wire response stays generic).

### Fixed
- **HITL re-arm loop** — the terminal prompt no longer re-arms after a decision arrives (board OR
  terminal) or after stdin EOF; fixes the **REVISE** infinite re-prompt spin (100% CPU, process
  never exits, Ctrl-C ineffective) and restores the second HITL gate on the revised draft.
- **Board hangs on RUNNING after a hard failure** — both orchestrators now publish a terminal
  STOPPED state on error, so the board reflects the failure instead of hanging.
- **Board store** — malformed state deltas with no `agentId` / `taskId` are skipped (the Zustand map
  is never keyed by `"undefined"`).
- **Fan-out/fan-in result↔index mismatch** (global-research, plan finding C1/HIGH) — search results
  are now mapped to their **dispatch** index by `taskId` (was indexed by `waitAll` completion-order
  position), so searchers that finish out of order get the correct sub-topic, node label and logged
  taskId.
- **Governance Action Gate fails closed** on a throwing validator; MCP-without-auth warning.
- **Byte-accurate data caps** — the 64 KB outbound-message and 20 KB state-event-result caps are now
  measured in **UTF-8 bytes** (`Buffer.byteLength`), truncating on a codepoint boundary (was UTF-16
  `.length`, which let multi-byte payloads exceed the byte cap).
- **Structured agent output** — the KaibanJS bridge now JSON-stringifies a non-string (object) LLM
  result instead of emitting `"[object Object]"`.
- **Model-pricing accuracy** — `estimateCost` normalizes OpenRouter slugs / dated suffixes
  (`openai/gpt-4o-mini`, `gpt-4o-2024-08-06`, `anthropic/claude-3-5-sonnet`) before pricing lookup,
  and warns on a default-pricing fallback (was exact-match only → slugs silently mis-priced).
- **Config robustness** — numeric env vars are parsed NaN-safe (`AGENT_TIMEOUT_MS=abc` no longer
  yields `setTimeout(…, NaN)` / instant timeouts).
- **Actor robustness** — a timed-out task handler's late rejection no longer surfaces as an
  `unhandledRejection`.
- **Global-research budget guard** now runs after **every** phase (search, write, governance,
  editorial), matching blog-team.
- A2A input validation hardened; de-stubbed `IDLE` / `TODO` placeholders. (BETA.1)

### Security
- The published library ships **0 HIGH/CRITICAL advisories**; release flow keeps SBOM + SLSA
  provenance + cosign signing (ADR-012).

## [1.5.0-beta] - 2026-06-16

### Pre-merge hardening pass (audit follow-up)
- **Container image CVEs** (cleared the new Trivy gate to 0 fixable CRITICAL/HIGH):
  `Dockerfile` runs `apk upgrade --no-cache` in both stages (self-heals base-image
  openssl/musl/zlib — incl. a CRITICAL openssl); installs with `npm ci` (lock-faithful,
  no transitive drift above the audited 0-high lock) and pins `glob >= 10.5.0` via
  `overrides`; and **removes the bundled npm CLI from the runtime stage** (the node
  base image's vendored npm shipped HIGH-CVE glob/minimatch/tar that the runtime —
  which only runs `node` — never uses). Also shrinks the image and reduces attack
  surface.
- **Kafka poison-message resilience**: the consumer now skips an unparseable
  (non-JSON) record (logs a warning, advances the offset) instead of throwing and
  crash-looping on it — matching the BullMQ path's tolerance.
- **Trace-header parity**: extracted a shared `sanitizeTraceHeaders` (drops
  non-string entries + rejects malformed `traceparent`); both BullMQ and Kafka
  drivers now use it (previously only BullMQ validated).
- **Timer leaks fixed**: `AgentActor` clears its per-task timeout when the handler
  wins the race; `SocketGateway` clears the token-expiry disconnect timer when a
  client disconnects early.
- **CompletionRouter**: rejects a duplicate `wait()` for an in-flight taskId
  instead of silently overwriting (which hung the first waiter).
- **Token budget wired**: `startAgentNode` now forwards `MAX_TOKEN_BUDGET` to the
  `AgentStatePublisher` (was loaded into config but never reached the worker path;
  0 = unlimited, so default behavior is unchanged).
- **CI**: added a Trivy image scan to the `docker` job (gate on fixable
  CRITICAL/HIGH, SARIF to the Security tab); `engines.node >= 22`; PR trigger now
  also covers `develop`; board job renamed to reflect it typechecks+builds (it has
  no eslint).
- **Docs**: corrected a broken ASVS→SECURITY.md link, stale test counts in
  BLOG_TEAM_TEST/EXAMPLES, the `--chaos/--searchers` example (global-research, not
  blog-team), `createKaibanTaskHandler`/`KaibanTeamBridge` signatures in SPEC,
  security impl paths + `JIT_TOKENS_ENABLED` in ACTOR_MODEL, and the documented
  `overrides` list in SECURITY.md.

### Security
- Cleared **all critical/high dependency advisories** (was 1 critical + 8 high):
  bumped `@opentelemetry/{sdk-node,auto-instrumentations-node,exporter-trace-otlp-http}`
  to the patched 0.217.x line and extended `package.json` `overrides`
  (`protobufjs`, `axios`, `@grpc/grpc-js`, `langsmith`, `ws`, `hono`, `qs`,
  `uuid`, `fast-uri`, `fast-xml-parser`, `ip-address`). Remaining 2 advisories
  are moderate, dev/build-only (see `SECURITY.md`).
- Added `SECURITY.md` (private reporting, key handling, supply-chain posture).

### Added
- CI/CD: `ci.yml` (lint, typecheck, enforced **100%** coverage, real madge gate,
  board tests, `npm audit` blocking on HIGH+, CycloneDX SBOM, gitleaks, OSV,
  CodeQL, Docker build), `nightly.yml` (Redis/Kafka/security e2e), `release.yml`
  (SBOM + SLSA provenance + Sigstore cosign signing), `scorecard.yml`.
- Governance: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`,
  `.github/dependabot.yml` (root + board + actions).
- `@opentelemetry/api` added as a direct dependency (was imported but undeclared).
- Unit test for the bootstrap/composition root (`src/main/index.ts`).

### Fixed
- **global-research**: editorial score always rendered `N/A` because the phase
  parsed the governance reviewer's `Compliance Score` label instead of the
  editor's `Accuracy Score` — corrected, with a regression test.
- Coverage gate was a no-op (thresholds mis-keyed for vitest 4 and `coverage.all`
  unset); now `coverage.all` + `include: src/**` + `coverage.thresholds` enforce
  a genuine 100% of `src/**`.
- Architecture gate was a no-op (`madge --circular src/` scanned 0 files); now
  uses `--extensions ts` (scans the TypeScript graph).

### Changed
- Reconciled open Dependabot PRs #17/#18 into a single controlled refresh.
- **Packaging**: added `src/index.ts` public-API barrel; `package.json`
  `main`/`types`/`exports`/`files` for a clean **library publish** (ships `dist/src`
  only — examples/board/tests excluded); `tsconfig.build` emits declarations.
- Removed 4 divergent duplicate `vitest.*.config.ts` (kept `.mts` + wired `test:e2e:live`).
- Docs softened to defensible/accurate wording: CI/Scorecard-backed badges; "one of
  the first" (not "the very first in the world"); compliance → capability language with
  a "library, not a certified product" disclaimer; corrected backoff (linear), result
  cap (20 000), and circuit-breaker threshold (10).
- `release.yml` now also builds, pushes, and **cosign-signs the container image**.

### Security (additional)
- Applied `sanitizeDelta` PII stripping on the worker `AgentStatePublisher` path
  (defense-in-depth; previously only the middleware path).
- Added `LICENSE-EXCEPTIONS.md` (GPL-3.0 SaaS-vs-distribution + commercial licensing).

### Observability & quality (additional)
- **OTel metrics**: `kaiban.message.processed` counter + `kaiban.message.latency`
  histogram via a `PeriodicExportingMetricReader` (OTLP when configured, Console in
  dev); emitted from the actor's success/DLQ paths.
- **Anomaly events**: `recordAnomalyEvent` wired at the actor level
  (`circuit_breaker.rejected`, `firewall.blocked`).
- **Benchmarks**: `bench/throughput.bench.ts` + `npm run bench` (vitest bench) +
  nightly job; **property tests** (fast-check) for channel-signing.
- **Lint**: `--max-warnings 0`; `examples/` now linted (browser-globals override
  for the viewer JS) — `npm run lint` covers src + tests + examples.
- **Deploy docs/manifests**: HELM gateway `secretRef` + accurate image-tag default;
  AWS ECS worker `CMD` note; Railway per-service guidance (no unsupported `railway.json`).
- **Structured logging (pino)**: `src/shared/structured-logger.ts` — JSON logs with
  PII redaction, child loggers, level via `LOG_LEVEL`, and opt-in `LOG_PRETTY=true`
  (pino-pretty) for readable local/demo output. Rolled out across **all production
  modules** (AgentActor, SocketGateway, GatewayApp, SlidingWindowBreaker,
  AgentStatePublisher, DistributedStateMiddleware, MCP client, KaibanAgentBridge,
  Telemetry) **and** the worker bootstrap (`main/index.ts`) + shared orchestration
  (`agent-node`, `orchestrator-state-publisher`) — all operational logging is now
  structured. The demo `createLogger` and HITL interactive prompts stay
  intentionally human-readable (terminal UX, not operational logs).
- **API-surface gate**: `@microsoft/api-extractor` (`api:check`/`api:update`) with a
  committed `etc/kaiban-distributed.api.md` report; CI fails on undocumented public-API
  drift — completing the 6-gate verification protocol.
- **Chaos / broker fault-injection e2e**: `test:e2e:chaos` pauses the Redis broker
  mid-flight and asserts every buffered publish flushes on recovery with **zero dropped
  agent messages**; fully isolated (own config, `afterAll`/`finally` always restore the
  broker) and wired into `nightly.yml`.
- **Mutation testing (Stryker)**: `test:mutation` over the pure `src/domain/**` layer —
  **96.61%** mutation score (break gate 85%), nightly job + HTML report. Remaining
  survivors are provably-equivalent mutants. (Stryker introduced no new HIGH/critical
  advisories.)
- **Accessibility**: board axe-core a11y tests (`vitest-axe`) across 6 components — 0 violations.
- **Container image scanning**: CI now scans the built Docker image with **Trivy**
  (gates on fixable CRITICAL/HIGH OS+library CVEs, `ignore-unfixed`, SARIF to the
  Security tab) — closing the image-layer gap the lockfile scanners can't see.
- **Doc accuracy (final reconciliation)**: corrected the remaining stale claims —
  unit/e2e **test counts** (769 unit / 77 files, 65 BullMQ-e2e) across README/EXAMPLES/
  BLOG_TEAM_TEST; firewall verdict shape (`{ allowed, reason }`); Kafka auto-create
  dev-vs-prod note; blog-team phase wait times (120/240/300 s); ADR-003 cost wording
  (estimated via `MODEL_PRICING`); "linear backoff" in `ACTOR_MODEL.md`. Declared
  `ts-node` as a devDep (the documented `npx ts-node` dev-run path). The in-repo audit
  matrix now shows **zero open items**.
- **Deployment**: verified + hardened Railway/Vercel/AWS/Azure — removed Vercel
  phantom steps; gateway `SOCKET_CORS_ORIGINS` everywhere; worker LLM keys/commands;
  health-check scoping (gateway-only); WEBSITES_PORT for Azure App Service.
