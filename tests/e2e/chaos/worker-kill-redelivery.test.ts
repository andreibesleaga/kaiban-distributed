/**
 * Chaos: SIGKILL a worker process in the middle of a task (BullMQ / Redis driver).
 * Two worker processes consume one queue and call a mock model. The test kills
 * the worker that runs the third task to start, while its model call is in
 * flight. BullMQ then finds the job stalled and hands it to the surviving
 * worker. Asserted: every task completes, the caller sees one completion for
 * each, the killed task ran again on the other worker, and the kill-to-completion
 * time is printed.
 * The lock settings are short (the driver passes them to the BullMQ Worker), so
 * recovery takes seconds, not the 30 s library default.
 * Requires: Redis via docker-compose (started by globalSetup).
 */
import { fork, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { resolve } from "path";
import { describe, it, expect, afterAll } from "vitest";
import { Queue } from "bullmq";
import { BullMQDriver } from "../../../src/infrastructure/messaging/bullmq-driver";
import { startMockModel, type MockModel } from "../helpers/mock-model";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const u = new URL(REDIS_URL);
const conn = { connection: { host: u.hostname, port: parseInt(u.port || "6379", 10) } };
const WORKER_FILE = resolve(__dirname, "fixtures/kill-worker.ts");

const TASKS = 6;
/** The task whose start (counted over both workers) triggers the kill. */
const KILL_ON_START = 3;
/** The model holds each call this long, so a call is in flight when the kill lands. */
const MODEL_HOLD_MS = 3_000;
const KILL_DELAY_MS = 300;
/** Short enough for a fast test, long enough that a busy CI runner does not lose a live worker's lock. */
const LOCK_DURATION_MS = 5_000;
const STALLED_INTERVAL_MS = 2_500;

interface WorkerEvent {
  type: "ready" | "start" | "end";
  worker: string;
  taskId?: string;
  at?: number;
}

interface Worker {
  id: string;
  child: ChildProcess;
  ready: Promise<void>;
}

const closers: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  while (closers.length) await closers.pop()!().catch(() => undefined);
});

function spawnWorker(id: string, queue: string, agentId: string, modelUrl: string, onEvent: (e: WorkerEvent) => void): Worker {
  const child = fork(WORKER_FILE, [], {
    execArgv: ["-r", "ts-node/register/transpile-only"],
    env: {
      ...process.env,
      REDIS_URL,
      QUEUE: queue,
      AGENT_ID: agentId,
      WORKER_ID: id,
      MODEL_URL: modelUrl,
      LOCK_DURATION_MS: String(LOCK_DURATION_MS),
      STALLED_INTERVAL_MS: String(STALLED_INTERVAL_MS),
      LOG_LEVEL: "silent",
    },
  });
  closers.push(
    () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("exit", () => done());
        child.kill("SIGKILL");
      }),
  );
  const ready = new Promise<void>((ok, fail) => {
    child.once("exit", (code) => fail(new Error(`worker ${id} exited early (${String(code)})`)));
    child.on("message", (m: WorkerEvent) => {
      if (m.type === "ready") ok();
    });
  });
  child.on("message", (m: WorkerEvent) => onEvent(m));
  return { id, child, ready };
}

async function waitUntil(done: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("Chaos: SIGKILL of a worker process mid-task", () => {
  it("the killed task is redelivered to the other worker; each task completes once for the caller", async () => {
    const agentId = `kill-${randomUUID().slice(0, 8)}`;
    const queue = `kaiban-agents-${agentId}`;
    const model: MockModel = await startMockModel(MODEL_HOLD_MS);
    closers.push(() => model.close());
    closers.push(async () => {
      const q = new Queue(queue, conn);
      await q.obliterate({ force: true });
      await q.close();
    });

    // What the caller sees: completion events of this run's tasks.
    const completions = new Map<string, number[]>();
    const watcher = new BullMQDriver(conn);
    closers.push(() => watcher.disconnect());
    const ids = Array.from({ length: TASKS }, (_, i) => `kill-${i}-${randomUUID().slice(0, 6)}`);
    await watcher.subscribe("kaiban-events-completed", async (p) => {
      if (ids.includes(p.taskId)) completions.set(p.taskId, [...(completions.get(p.taskId) ?? []), performance.now()]);
    });

    // What the workers report: every start of a task, in arrival order.
    const starts: Array<{ taskId: string; worker: string }> = [];
    const victimRef: { current?: { taskId: string; worker: string; killedAt: number } } = {};
    let killTimer: NodeJS.Timeout | undefined;
    const workers: Worker[] = [];
    const onEvent = (e: WorkerEvent): void => {
      if (e.type !== "start" || !e.taskId) return;
      starts.push({ taskId: e.taskId, worker: e.worker });
      if (starts.length !== KILL_ON_START) return;
      const target = workers.find((w) => w.id === e.worker)!;
      const victim = { taskId: e.taskId, worker: e.worker, killedAt: 0 };
      victimRef.current = victim;
      killTimer = setTimeout(() => {
        victim.killedAt = performance.now(); // monotonic: a wall-clock correction cannot reorder it
        target.child.kill("SIGKILL");
      }, KILL_DELAY_MS);
    };
    closers.push(async () => clearTimeout(killTimer));
    workers.push(spawnWorker("w0", queue, agentId, model.url, onEvent), spawnWorker("w1", queue, agentId, model.url, onEvent));
    await Promise.all(workers.map((w) => w.ready));

    const sender = new BullMQDriver(conn);
    closers.push(() => sender.disconnect());
    for (const taskId of ids) await sender.publish(queue, { taskId, agentId, data: {}, timestamp: Date.now() });

    await waitUntil(() => ids.every((id) => completions.has(id)), 45_000, "all tasks to complete");
    await new Promise((r) => setTimeout(r, 4_000)); // a late duplicate would arrive here

    const killed = victimRef.current;
    if (!killed) throw new Error("no task start reached the kill point");
    expect(killed.killedAt, "a worker was killed").toBeGreaterThan(0);
    for (const id of ids) expect(completions.get(id), `completions of ${id}`).toHaveLength(1);

    const victimStarts = starts.filter((s) => s.taskId === killed.taskId);
    expect(victimStarts.length).toBeGreaterThanOrEqual(2);
    expect(victimStarts[0]!.worker).toBe(killed.worker);
    expect(victimStarts.slice(1).every((s) => s.worker !== killed.worker)).toBe(true);
    // The model call of the killed task ran again: more model requests than tasks.
    expect(model.requests()).toBeGreaterThan(TASKS);

    const recoveryMs = Math.round(completions.get(killed.taskId)![0]! - killed.killedAt);
    console.log(
      `[chaos] killed ${killed.worker} during ${killed.taskId}; redelivered to ` +
        `${victimStarts[1]!.worker}; kill-to-completion ${recoveryMs} ms ` +
        `(lock ${LOCK_DURATION_MS} ms, stalled check ${STALLED_INTERVAL_MS} ms, ` +
        `${starts.length} starts for ${TASKS} tasks, ${model.requests()} model calls)`,
    );
    expect(recoveryMs).toBeGreaterThan(0);
  }, 90_000);
});
