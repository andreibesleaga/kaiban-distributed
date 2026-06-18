# ADR-014: AbortSignal cancellation — own the LangChain LLM instance

- Status: Accepted
- Date: 2026-06

## Context
`AgentActor.executeTask` raced the task handler against a per-task timeout
(`Promise.race([handler, timeout])`) but **never cancelled the handler**. On
timeout the actor rejected the race and moved on, while the underlying KaibanJS
`team.start()` → LangChain LLM request **kept running to completion, burning
tokens** for a result nobody would use (Finding #2 — zombie token burn). The same
applies on graceful shutdown.

KaibanJS `0.24.2` exposes **no AbortSignal**: `team.start()` cannot be passed a
signal, and `team.stop()` does not abort the in-flight LLM HTTP request
(master plan §B2/A9). So abort must be plumbed at the **LangChain
`.invoke(input, { signal })`** layer — which means **owning the LLM instance**.

## Decision
1. **`TaskHandler` gains a signal:** `(payload, signal?: AbortSignal) => Promise<unknown>`.
   The actor creates one `AbortController` per task, races the handler against the
   timeout, and on timeout **aborts the controller** (then rejects). `stop()`
   aborts every in-flight controller. The signal is optional in the *type* so
   existing handlers/tests compose, but the actor **always** passes a real signal.
2. **Own the LangChain LLM (`src/infrastructure/kaibanjs/owned-llm.ts`):**
   KaibanJS accepts a pre-built LangChain model via `Agent({ llmInstance })` and
   uses it verbatim. `buildOwnedLlm(llmConfig, signal)` constructs a
   `ChatOpenAI` (the only provider this runtime resolves — OpenAI / OpenRouter /
   OpenAI-compatible base URL, see `build-llm-config.ts`) and **wraps its
   `.invoke` / `.stream`** so the actor's signal is merged (via `AbortSignal.any`)
   into the `RunnableConfig.signal` on every call. When the actor aborts, the
   provider request aborts and token spend stops.
3. **The bridge wires it:** `createKaibanTaskHandler` builds the owned instance
   when a signal is present and an OpenAI-compatible config is resolved, and passes
   it as `llmInstance`. With no signal (legacy direct call) or a non-OpenAI
   provider, KaibanJS builds its own instance from env — unchanged behavior.

## Limitations (explicit)
- Cancellation is **provider-scoped to the OpenAI-compatible path**, which is the
  only provider this runtime resolves. For a hypothetical non-OpenAI provider,
  `buildOwnedLlm` returns `undefined` and KaibanJS owns the instance — the
  actor-level timeout + DLQ still fire, but **in-flight token spend cannot be
  cancelled** for that call. No KaibanJS fork was needed for the supported path.
- `@langchain/openai` is now a **direct dependency** (was transitive via
  `kaibanjs`), pinned `^0.5.7` to match KaibanJS's own range so the owned model is
  the same class KaibanJS uses (no `lc_namespace`/`instanceof` mismatch).

## Consequences
- **+** A timed-out / shut-down task stops burning tokens (cost + safety).
- **+** Abort is standard LangChain plumbing — no KaibanJS fork, no monkey-patch of
  KaibanJS internals.
- **−** One new direct dependency (`@langchain/openai`) — already hoisted, version
  aligned with KaibanJS.
- **−** Cancellation depth is bounded by the owned-instance path (above).

## Invariants
Preserves §B1.2: still let-it-crash (an aborted handler rejects → retry/DLQ);
`taskId` dedup unchanged; data caps unchanged; security defaults unchanged. Guard
tests: `AgentActor-abort.test.ts` (signal passed; aborted on timeout + on stop),
`owned-llm.test.ts` (signal injected into invoke/stream; combined signals;
non-openai → undefined), `kaiban-agent-bridge-abort.test.ts` (llmInstance injected
with the actor signal; legacy/no-signal path unchanged).
