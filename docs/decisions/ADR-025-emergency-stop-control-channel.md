# ADR-025: Emergency STOP ALL — the `kaiban-control` channel

- Status: Accepted
- Date: 2026-11-03
- Spec: [roadmap §6.10](../roadmap/V2.1-ROADMAP.md) (requirements ES-1 to ES-12, scenarios A1 to A10)

## Context
Until 2.0.3 an operator could stop work only by signalling a process: SIGTERM or SIGINT drains one
worker, a timeout ends one task, and A2A `tasks/cancel` stops only the gateway's wait. No message
reached a running worker: task mailboxes are competing-consumer queues, and workers subscribe to no
broadcast channel. A runaway fleet (a looping workflow, a model spending money, an agent doing harm)
had no single off switch.

The roadmap (§6) designs STOP, PAUSE and RESUME for workflows, tasks and agents. 2.1.0 ships only the
emergency stop of everything.

## Decision
1. **A sixth channel, `kaiban-control`, on Redis Pub/Sub**, whatever `MESSAGING_DRIVER` is (as the
   state and review channels, invariant I5). Messages are signed with `wrapSigned`
   (`CHANNEL_SIGNING_SECRET`); a message that fails `unwrapVerified` is ignored and logged.
   The five existing channels and their payloads do not change.
2. **One command, `STOP_ALL`**: `{ commandId, command, issuedBy, issuedAt, reason? }`, validated with
   zod. `issuedAt` is the stop moment.
3. **The stop is a moment, not a mode.** Every task sent at or before it ends; every task sent after
   it runs normally. There is no hold and nothing to release. The latest moment is kept in Redis
   (key `kaiban-control:stopped-at`), written before the message is published; every node reads it
   when it starts and when its Redis connection comes back, so a node that missed the message still
   refuses the old tasks. With `CHANNEL_SIGNING_SECRET` set the saved command carries a durable
   HMAC signature (no freshness limit) and an unsigned or altered value is ignored. A node that
   cannot read the key at start does not start (fail closed); a failed read after a reconnect is
   retried until it succeeds.
4. **Worker nodes** (`AgentActor.emergencyStop(stoppedAt)`): every running task sent before the
   moment is aborted with a non-retryable `EmergencyStopError` and settled at once (the actor does not
   wait for the handler); every such task delivered later is refused without running. Both publish a
   failure record (`error: "emergency_stop"`, replayable) and task status `STOPPED`, an additive
   `TaskStatus` member.
5. **Orchestrators** take an optional stop signal (`AbortSignal`) built from the same channel and
   key. It aborts the current task wait and the human-review wait with `EmergencyStopError`, and no
   further step is dispatched.
6. **Ingress:** the board (socket event, confirmation dialog), `POST /control/stop-all` on the
   gateway, and `npm run stop-all`. Board and HTTP commands always require a valid board token:
   control is refused when `BOARD_JWT_SECRET` is unset, even where the board's read-only view runs
   without authentication.
7. **Default off.** With `CONTROL_PLANE_ENABLED` unset, no subscription, route, socket event or
   status is added; behaviour is that of 2.0.3.
8. **Acknowledgements** travel on the existing state channel as a `control` delta (`applied` or
   `noop`, node id, number of aborted tasks). The gateway also subscribes to the control channel, so
   the snapshot it gives boards carries the latest stop from any source, the CLI included.

## Consequences
- One press kills every running model call, task and workflow, including tasks still queued.
- Every running model call is killed: the owned model instance cancels the provider request
  mid-call (ADR-014), the KaibanJS team is stopped, and the actor settles the task at once even when
  a custom handler ignores its signal (its late result is discarded). This covers every task run by
  an `AgentActor`. The deprecated in-process `KaibanTeamBridge` only stops its team at the next step
  when its `start(inputs, signal)` signal aborts; a model call already in flight there finishes.
- Nothing is resumed: stopped work is replayed from the failure queue, on purpose.
- The stop moment is compared with each task's send time from the sender's clock, so the hosts'
  clocks must be synchronised (NTP); a task sent within the skew can fall on either side.
  The live command is verified by its signature only, without the 30-second freshness window of the
  state channel, so a stop from a host whose clock is off is never dropped; an older stop replayed
  later is a no-op because the stop moment only moves forward.
- Redis becomes a hard dependency of the control plane, including Kafka deployments (already true
  for state and review decisions).
- Every board token can stop everything; per-role authorisation comes with a later version.

## Later versions (not in this ADR)
Release and hold; pause with checkpoints, rehydrate and resume; stop, pause or resume per agent,
node, model, task or workflow; the command ledger and *unconfirmed* display; the `lifecycle-control`
Action Gate operation, lifecycle audit records and a `board-admin` role; A2A `tasks/cancel` and an
MCP control tool on this channel (roadmap §6.3 to §6.9, §7.3).
