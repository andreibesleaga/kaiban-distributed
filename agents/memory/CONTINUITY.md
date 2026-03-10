# CONTINUITY — Project Failure Memory
<!-- Checked EVERY session start (RARV Reason Phase — mandatory) -->
<!-- Prevents agents from repeating past failed approaches -->
<!-- Append new entries. Never delete. Mark RESOLVED if superseded. -->

---

## How to Use This File

During RARV Reason phase, EVERY agent MUST:
1. Scan this file for entries related to the current module or operation
2. If relevant entry found → apply the recorded resolution WITHOUT rediscovering
3. After a novel failure is resolved → add an entry here

Entry format:
```
### [Module/Area] — [Short description]
**Failed approach**: [what was tried]
**Why it failed**: [root cause]
**Resolution**: [what actually worked]
**Date**: [YYYY-MM-DD]
**Status**: ACTIVE | RESOLVED (superseded by entry #N)
```

---

## Entries

*(Empty — add entries as failures are encountered and resolved)*

<!-- Example entry (delete this comment when real entries are added):

### Auth Module — JWT token refresh race condition
**Failed approach**: Checking token expiry in middleware and refreshing inline
**Why it failed**: Concurrent requests both see expired token, both refresh, second refresh invalidates first
**Resolution**: Refresh tokens via dedicated /api/v1/auth/refresh endpoint with mutex lock in Redis
**Date**: 2026-01-15
**Status**: ACTIVE
-->

---

## Quick Reference — Common Failure Patterns to Avoid

*(Populated as project matures — move crystallized patterns here)*

| Pattern | Area | What to avoid | What to do instead |
|---------|------|---------------|-------------------|
| *(none yet)* | | | |
## S07 Learnings (2026-03-10)

### BullMQ Queue Name Restriction
**Problem:** BullMQ >= v5 rejects queue names containing colons (:).
**Failed approach:** Using `kaiban:state:events` as BullMQ queue names.
**Resolution:** Rename all queue names to use dashes: `kaiban-events-completed`, `kaiban-events-failed`, `kaiban-state-events`, `kaiban-agents-{id}`.
**Note:** SocketGateway uses ioredis pub/sub (which DOES support colons) — the two patterns are separate.

### cat >> File Structure
**Problem:** Using `cat >>` to append test cases outside a describe block.
**Resolution:** Always rewrite entire test files with `cat > file << 'EOF'` — never append partial blocks.

### vi.mock() Hoisting
**Problem:** `vi.mock()` is hoisted before variable declarations; cannot reference external `const` variables inside the factory.
**Resolution:** Define all mock functions directly inside `vi.mock(() => ({ ... vi.fn() ... }))` factory, then use `vi.mocked()` to access them after import.

### kaibanjs CVEs
**Problem:** kaibanjs >= 0.3.0 has 4 high CVEs via transitive deps (@langchain/community, expr-eval, langsmith).
**Resolution:** Cannot auto-fix (would downgrade to v0.0.1 breaking change). Document and escalate to human.

## SDLC S09 — TraceContext Dead Code (2026-03-10)
**Problem:** `TraceContext.ts` (inject/extract helpers) was never imported anywhere — dead code violating Constitution Article VII.
**Resolution:** Wired into both `BullMQDriver.publish()` and `BullMQDriver.subscribe()` worker callback, and same for `KafkaDriver`. Uses `otelContext.with(ctx, handler)` for proper span context propagation.
**Test pattern:** Mock `@opentelemetry/api` with `vi.mock("@opentelemetry/api", ...)` — must be at top of test file.
**New coverage pattern:** The `?? {}` fallback for missing `traceHeaders` requires a test with a payload that has no `traceHeaders` field.
