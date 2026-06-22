# ADR-013: Gateway / Worker role split (single image, `ROLE`-selected)

- Status: Accepted
- Date: 2026-06

## Context
The single entrypoint `src/main/index.ts` built one process that BOTH served the
HTTP / WebSocket / A2A surface AND constructed `AgentActor`s for every
`AGENT_IDS` entry — but with an **`undefined` task handler**:

```ts
config.agentIds.map(agentId =>
  new AgentActor(agentId, driver, `kaiban-agents-${agentId}`, undefined, {...}))
```

`AgentActor.start()` warned and subscribed anyway, and `executeTask` fell back to
`delay(50); return null`. In a real deployment those handler-less actors compete
as BullMQ/Kafka consumers on `kaiban-agents-{id}` against the real per-agent
worker nodes and **silently win and discard tasks** (Finding #1 — silent task
discard). The completed event reports a fake success; the LLM work never runs.

## Decision
Split the entrypoint into two roles behind a single image, selected at runtime by
the `ROLE` environment variable:

- **`src/main/gateway.ts` (`runGateway`)** — the HTTP / WebSocket / A2A front door
  ONLY. It wires the messaging driver (to publish A2A-received tasks), the
  `A2AConnector`, the `SocketGateway`, and the HTTP server. It builds **no**
  `AgentActor`s — the gateway never consumes task channels.
- **`src/main/worker.ts` (`runWorker`)** — loads the `AGENT_IDS` pool and wires a
  **real, LLM-backed, AbortSignal-aware** task handler for each agent via
  `startAgentNode` (driver + security deps + state publisher + KaibanJS handler).
  No HTTP surface.
- **`src/main/index.ts`** — a thin dispatcher: `resolveRole(process.env.ROLE)` →
  `runGateway()` or `runWorker()`. Default is `gateway` (backward-compatible: the
  old single entrypoint exposed `/health`); an unknown `ROLE` is rejected loudly.

`AgentActor` now **throws on `start()` when no handler was provided** and the
silent `delay(50); return null` fallback is **removed**. A handler-less actor can
no longer subscribe and discard tasks — it is a hard, fail-loud error.

`Dockerfile` takes a `ROLE` build-arg/env (default `gateway`); `docker-compose.yml`
sets `ROLE=worker` on the worker service; the deployment docs (k8s/helm) select
`ROLE` per deployment; the `dev` npm script is role-aware.

## Consequences
- **+** No more silent task discard — the gateway cannot win a task it can't run;
  workers are the only consumers, and every worker actor has a real handler.
- **+** One image, two roles — `kubectl scale` the worker tier independently of the
  gateway; clean separation of the HTTP surface from task execution.
- **+** Fail-loud: a mis-wired actor throws at startup instead of corrupting the
  workflow with fake completions.
- **−** Breaking deploy change: a process that previously "did everything" must now
  pick `ROLE`. Documented in `MIGRATION.md`. Workers MUST set `ROLE=worker`.
- **−** The generic worker image uses a default agent persona
  (`buildDefaultAgentConfig`); richer personas still come from example
  `team-config.ts` via `startAgentNode`.

## Invariants
Preserves §B1.2: message-passing only (gateway publishes, workers consume); the
state/HITL channels stay on Redis Pub/Sub; workers never set `teamWorkflowStatus`;
data caps unchanged. Guard tests: `AgentActor-requires-handler.test.ts` (throw +
no-subscribe), `main/gateway.test.ts` (gateway builds NO `AgentActor`),
`main/worker.test.ts` (one real handler per agent), `main/index.test.ts` (role
dispatch never runs both).
