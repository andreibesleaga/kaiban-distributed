import type { IMessagingDriver, MessagePayload } from "./interfaces";

/**
 * AmqpDriver — an UNIMPLEMENTED universal AMQP (`amqplib`) seam.
 *
 * v2.0 ships this as a declared-but-unimplemented `IMessagingDriver` so the AMQP
 * extension point exists for a future release. **Every method throws.** The two
 * real, supported drivers are BullMQ/Redis (default) and Kafka.
 *
 * To implement later (NOT built in v2.0): `amqplib` (^0.10) + `amqp-connection-manager`,
 * quorum queues, confirm channel + `waitForConfirms()`, `prefetch(1)`, DLX + TTL,
 * W3C `traceparent` in `properties.headers` — and it MUST preserve the channel-split
 * invariant (`kaiban-state-events` / `kaiban-hitl-decisions` stay on Redis Pub/Sub
 * regardless of `MESSAGING_DRIVER`). See `docs/messaging/AMQP.md` + ADR-016.
 *
 * This file is **coverage-excluded** by design (`vitest.config.mts`) — it ships no
 * implementation and no tests; the factory routing to it IS tested.
 */
const NOT_IMPLEMENTED =
  'AMQP driver is not implemented (roadmap). Use MESSAGING_DRIVER="bullmq" or "kafka".';

export class AmqpDriver implements IMessagingDriver {
  publish(_queueName: string, _payload: MessagePayload): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  subscribe(
    _queueName: string,
    _handler: (payload: MessagePayload) => Promise<void>,
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  unsubscribe(_queueName: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  disconnect(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
