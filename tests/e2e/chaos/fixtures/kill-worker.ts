/**
 * One worker process for the worker-kill chaos test. It runs an AgentActor on
 * the BullMQ (Redis) driver with a handler that makes one HTTP call to the mock
 * model, and reports to the test over the IPC channel. The test starts it with
 * `child_process.fork`; it is not a test file.
 *
 * Environment: REDIS_URL, QUEUE, AGENT_ID, WORKER_ID, MODEL_URL,
 * LOCK_DURATION_MS, STALLED_INTERVAL_MS.
 */
import { AgentActor } from "../../../../src/application/actor/AgentActor";
import {
  BullMQDriver,
  type BullMQDriverOptions,
} from "../../../../src/infrastructure/messaging/bullmq-driver";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function report(message: Record<string, unknown>): void {
  if (process.send) process.send(message);
}

async function main(): Promise<void> {
  const url = new URL(required("REDIS_URL"));
  const workerId = required("WORKER_ID");
  const modelUrl = required("MODEL_URL");
  // BullMQDriver hands its options to the BullMQ Worker as they are, so the
  // lock settings of the Worker pass through the same object.
  const options: BullMQDriverOptions & {
    lockDuration: number;
    stalledInterval: number;
  } = {
    connection: { host: url.hostname, port: parseInt(url.port || "6379", 10) },
    lockDuration: Number(required("LOCK_DURATION_MS")),
    stalledInterval: Number(required("STALLED_INTERVAL_MS")),
  };
  const driver = new BullMQDriver(options);

  const actor = new AgentActor(
    required("AGENT_ID"),
    driver,
    required("QUEUE"),
    async (payload, signal) => {
      report({ type: "start", taskId: payload.taskId, worker: workerId, at: Date.now() });
      const response = await fetch(`${modelUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: payload.taskId }] }),
        ...(signal ? { signal } : {}),
      });
      await response.text();
      report({ type: "end", taskId: payload.taskId, worker: workerId, at: Date.now() });
      return "ok";
    },
  );
  await actor.start();
  report({ type: "ready", worker: workerId });

  // The test runner died: do not stay behind as an orphan.
  process.once("disconnect", () => process.exit(0));
  process.once("SIGTERM", () => {
    void actor
      .stop()
      .then(() => driver.disconnect())
      .finally(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  console.error("kill-worker failed", err);
  process.exit(1);
});
