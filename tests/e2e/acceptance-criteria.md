# Acceptance Criteria (E2E)

Each scenario names the test that checks it. A scenario without a test says so. The e2e tests need Docker (`npm run test:e2e`; the Kafka, security and chaos suites have their own `test:e2e:*` scripts). The stop-all scenarios are in [docs/roadmap/V2.1-ROADMAP.md](../../docs/roadmap/V2.1-ROADMAP.md), section 6.10 (A1 to A10).

## Feature: Distributed Task Execution

**Scenario: A task published to the queue is consumed by an agent on another node.**

- **Given** an agent node (`AgentActor`) is subscribed to its queue.
- **When** a task is published to that queue.
- **Then** the node consumes the task, runs its handler and publishes the result on the completed channel.

Test: `tests/e2e/distributed-execution.test.ts` "Scenario 1: Task published to queue is consumed by AgentActor".

**Scenario: Several clones of one agent share the work.**

- **Given** several instances of the same agent read the same queue.
- **When** many tasks are published.
- **Then** each task is handled exactly once.

Test: `tests/e2e/horizontal-scaling-bullmq.test.ts` (and `tests/e2e/horizontal-scaling-kafka.test.ts` for Kafka).

**Scenario: A multi-agent pipeline runs to the end.**

- **When** an orchestrator sends tasks to several agents on separate nodes, in order, with a human decision at the end.
- **Then** each stage's result feeds the next and the workflow ends `FINISHED` (or `STOPPED` on a rejection).

Tests: `tests/e2e/blog-team-flow.test.ts` (scenarios 1 to 6), `tests/e2e/global-research-flow.test.ts` (scenarios 1 to 3); fan-out and fan-in of many tasks in `tests/e2e/fan-out-fan-in.test.ts`.

Not covered by an automated test: "the final result is identical to a monolithic KaibanJS execution". The e2e tests use a mock model, so there is no monolithic run to compare with.

## Feature: Fault Tolerance

**Scenario: A handler that keeps failing.**

- **Given** a handler that fails on every attempt.
- **When** the task is delivered.
- **Then** it is attempted 3 times and one record lands on `kaiban-events-failed`.

Test: `tests/e2e/distributed-execution.test.ts` "Scenario 2: Fault tolerance - retry on failure publishes to DLQ".

**Scenario: The broker is paused and resumed.**

- **Given** Redis is paused while tasks are being published.
- **When** Redis is resumed.
- **Then** no task is lost (delivery is at least once).

Test: `tests/e2e/chaos/broker-resilience.test.ts`.

**Scenario: STOP ALL while a task runs.**

- **Given** a worker is processing a task.
- **When** STOP ALL is issued.
- **Then** the task is aborted and recorded as `emergency_stop`, and a task sent afterwards runs.

Tests: `tests/e2e/emergency-stop.test.ts` (A1, A2 + A3), `tests/e2e/emergency-stop-kafka.test.ts`, `tests/e2e/chaos/emergency-stop-storm.test.ts`.

**Scenario: A worker process is killed mid-task.** Not covered by an automated test.

- A graceful stop (SIGTERM drain, `AgentActor.stop()`) dead-letters the running task as `actor_stopped`, replayable from the failure queue (DLQ replay, `src/resilience/dlq-replay.ts`). A killed process publishes nothing: the broker decides. BullMQ marks the job stalled when its lock expires (30 s) and hands it once more to any worker of that queue (library defaults); Kafka re-delivers the uncommitted message to the partition's next consumer after the rebalance. Neither resumes the task's progress.

## Feature: UI Synchronization

**Scenario: State changes reach the board.**

- **Given** a board is connected to the gateway.
- **When** a worker on another server changes a task state.
- **Then** the state event travels over Redis Pub/Sub to the gateway and on to the board, without a page refresh.

Tests: the Pub/Sub half is `tests/e2e/distributed-execution.test.ts` "Scenario 3: DistributedStateMiddleware publishes state changes via Redis Pub/Sub" and `tests/e2e/event-isolation.test.ts`; the board half is `board/e2e/board-visual.spec.ts` and the board unit tests. No single test runs a real worker, the gateway and a browser together; the Docker runs in `docs/VERIFICATION.md` do that by hand.

## Feature: Human decision from the board

**Scenarios: PUBLISH, REVISE, REJECT, an invalid decision, a wrong task id, a malformed payload, a repeated decision and two orchestrators at once.**

Test: `tests/e2e/board-hitl-integration.test.ts` (scenarios 1 to 10).
