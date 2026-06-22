# AMQP driver (unimplemented seam)

kaiban-distributed ships a **universal AMQP driver seam** but **does not implement it** in v2.0.
The two supported messaging drivers are **BullMQ/Redis** (default) and **Kafka**.

- `MESSAGING_DRIVER=amqp` selects `AmqpDriver` (`src/infrastructure/messaging/amqp-driver.ts`),
  whose methods throw `AMQP driver is not implemented (roadmap)`. The slot exists so a future
  release can add a real AMQP driver without a public-API change (`AmqpDriver` is already exported).

## Implementing it later (roadmap)
A real driver should use **`amqplib` (^0.10)** + **`amqp-connection-manager`** (auto-reconnect +
topology re-setup; bare amqplib doesn't auto-recover), with: **quorum queues** (classic mirroring
was removed in RabbitMQ 4.0), a **confirm channel** + `waitForConfirms()`, **`prefetch(1)`** (fair
competing-consumer), **DLX + message-TTL** poison handling (never a blind `nack(requeue)`), and the
W3C `traceparent` propagated in `properties.headers` (mirror `kafka-driver.ts`).

It MUST preserve the **channel-split invariant**: `kaiban-state-events` and `kaiban-hitl-decisions`
stay on **Redis Pub/Sub** regardless of `MESSAGING_DRIVER`. See ADR-016 + the master plan §B1.2/§B3.
