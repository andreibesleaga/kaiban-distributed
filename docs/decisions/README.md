# Architecture decision records

One file per decision. A decision keeps its history: when something changes, a dated **Update** note at the end of the file gives the corrected facts, and the original text stays as it was.

| ADR | Topic | Status |
| --- | --- | --- |
| [001](ADR-001-messaging-driver-abstraction.md) | Messaging driver abstraction (`IMessagingDriver`) | Accepted |
| [002](ADR-002-bullmq-queue-naming.md) | BullMQ queue naming (dashes, not colons) | Accepted |
| [003](ADR-003-kaiban-team-bridge-pattern.md) | KaibanJS integration, bridge pattern | Accepted |
| [004](ADR-004-hitl-editorial-review.md) | Human decision after the editorial review | Accepted |
| [005](ADR-005-trace-context-propagation.md) | W3C trace context propagation | Accepted |
| [006](ADR-006-result-monad-error-handling.md) | `Result<T, E>` for domain errors | Accepted |
| [007](ADR-007-semantic-firewall-design.md) | Heuristic semantic firewall (opt-in) | Accepted |
| [008](ADR-008-jwt-authentication.md) | Environment-gated JWT authentication | Accepted |
| [009](ADR-009-ddd-layering.md) | Domain-driven layering | Accepted |
| [010](ADR-010-circuit-breaker-policy.md) | Sliding-window circuit breaker | Accepted |
| [011](ADR-011-dual-license.md) | Dual licence (Apache-2.0 library, GPL-3.0 application) | Accepted |
| [012](ADR-012-dependency-policy.md) | Dependency policy | Accepted; superseded in practice by the same-major rule (see its update note) |
| [013](ADR-013-gateway-worker-split.md) | Gateway and worker role split | Accepted |
| [014](ADR-014-abort-signal.md) | AbortSignal cancellation | Accepted |
| [015](ADR-015-a2a-sdk-v0.3.md) | Official A2A SDK v0.3 server | Accepted |
| [016](ADR-016-amqp-driver-seam.md) | AMQP driver seam (not implemented) | Accepted |
| [017](ADR-017-mcp-server.md) | MCP server | Accepted |
| [018](ADR-018-resilience-orchestrator.md) | Resilience layer and crash-safe orchestrator | Accepted |
| [019](ADR-019-economics-finops.md) | Economics / FinOps layer | Accepted |
| [020](ADR-020-governance-action-gate.md) | Governance: Action Gate, audit chain, policy as code | Accepted |
| [021](ADR-021-hot-path-enforcement.md) | Hot-path enforcement in the agent actor | Accepted |
| 022 | Federation-egress enforcement | Planned, not written (roadmap section 1) |
| 023 | Default fleet cost limiter | Planned, not written (roadmap section 2) |
| 024 | CloudEvents / AsyncAPI message envelope | Planned, not written (roadmap section 3) |
| [025](ADR-025-emergency-stop-control-channel.md) | Emergency STOP ALL, the `kaiban-control` channel | Accepted (STOP ALL only; the rest of roadmap section 6 is planned as 026) |

Numbers 022 to 024 were reserved for planned decisions and have never been used for a file, so the list jumps from 021 to 025.

Some older ADRs mention section numbers such as "§B1.2" or "invariant #8". Those point to the v2.0 planning notes, which are private and not in this repository; the ADR text itself is the public record.
