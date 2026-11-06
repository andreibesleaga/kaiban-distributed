/**
 * agent-node helpers shared with custom worker entry points (WF-09): the
 * global-research searcher uses them so it honours AGENT_TIMEOUT_MS /
 * RETRY_ON_TIMEOUT and drains like every other node.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const drainMock = vi.hoisted(() => ({ fn: undefined as undefined | (() => Promise<boolean>) }));
vi.mock("../../../src/shared/process-drain", () => ({
  registerNodeDrain: (f: () => Promise<boolean>): void => { drainMock.fn = f; },
}));

import { actorTimeoutOptionsFromEnv, registerWorkerDrain } from "../../../src/shared/agent-node";

afterEach(() => {
  delete process.env["AGENT_TIMEOUT_MS"];
  delete process.env["RETRY_ON_TIMEOUT"];
});

describe("actorTimeoutOptionsFromEnv", () => {
  it("is empty when nothing is set", () => {
    expect(actorTimeoutOptionsFromEnv()).toEqual({});
  });
  it("reads AGENT_TIMEOUT_MS and RETRY_ON_TIMEOUT", () => {
    process.env["AGENT_TIMEOUT_MS"] = "60000";
    process.env["RETRY_ON_TIMEOUT"] = "true";
    expect(actorTimeoutOptionsFromEnv()).toEqual({ taskTimeoutMs: 60000, retryOnTimeout: true });
    process.env["RETRY_ON_TIMEOUT"] = "1";
    expect(actorTimeoutOptionsFromEnv().retryOnTimeout).toBe(true);
  });
  it("ignores text, zero and negative timeouts and other retry literals", () => {
    for (const bad of ["abc", "0", "-5"]) {
      process.env["AGENT_TIMEOUT_MS"] = bad;
      expect(actorTimeoutOptionsFromEnv()).toEqual({});
    }
    process.env["RETRY_ON_TIMEOUT"] = "yes";
    expect(actorTimeoutOptionsFromEnv()).toEqual({});
  });
});

describe("registerWorkerDrain", () => {
  it("stops the actor, closes control, driver and publisher, and reports a clean drain", async () => {
    const calls: string[] = [];
    registerWorkerDrain({
      actor: { stop: async (): Promise<void> => { calls.push("actor"); } },
      control: { close: async (): Promise<void> => { calls.push("control"); } } as never,
      driver: { disconnect: async (): Promise<void> => { calls.push("driver"); } } as never,
      statePublisher: { disconnect: async (): Promise<void> => { calls.push("publisher"); } },
    });
    await expect(drainMock.fn!()).resolves.toBe(true);
    expect(calls).toEqual(["actor", "control", "driver", "publisher"]);
  });

  it("works without a control handle and reports a failed step", async () => {
    registerWorkerDrain({
      actor: { stop: async (): Promise<void> => { throw new Error("stuck"); } },
      control: null,
      driver: { disconnect: async (): Promise<void> => {} } as never,
      statePublisher: { disconnect: async (): Promise<void> => {} },
    });
    await expect(drainMock.fn!()).resolves.toBe(false);
  });
});
