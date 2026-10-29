// SPDX-License-Identifier: Apache-2.0
/**
 * One drain per worker process. A worker runs one agent node per agent
 * (`runWorker` calls `startAgentNode` once per agent); when each node exited the
 * process from its own drain, the first node to finish cut the others short.
 * Every node registers its drain here instead: the first SIGTERM (orchestrator)
 * or SIGINT (Ctrl-C) runs all of them together, then flushes telemetry, then
 * exits once — 0 only when every node drained cleanly.
 *
 * Internal: not exported from the package.
 */
import {
  deferTelemetryShutdown,
  shutdownTelemetry,
} from "../infrastructure/telemetry/telemetry-shutdown";

/** Drains one node; resolves true when it finished cleanly. Must not reject. */
export type NodeDrain = () => Promise<boolean>;

let drains: NodeDrain[] = [];
let listening = false;
let draining = false;

/** Add a node's drain; the signal listeners are registered on the first call. */
export function registerNodeDrain(drain: NodeDrain): void {
  drains.push(drain);
  if (listening) return;
  listening = true;
  // This drain flushes telemetry after every node; the SDK's listener must not flush first.
  deferTelemetryShutdown();
  process.on("SIGTERM", drainProcess);
  process.on("SIGINT", drainProcess);
}

function drainProcess(): void {
  if (draining) return;
  draining = true;
  void (async (): Promise<void> => {
    const clean = await Promise.all(
      drains.map((drain) => drain().catch(() => false)),
    );
    // Last: the exit below must not cut the final span/metric batch.
    await shutdownTelemetry();
    process.exit(clean.every(Boolean) ? 0 : 1);
  })();
}

/** Test seam: forget every registered drain and the listener/drain state. */
export function resetProcessDrain(): void {
  drains = [];
  listening = false;
  draining = false;
}
