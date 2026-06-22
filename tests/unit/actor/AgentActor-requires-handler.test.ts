/**
 * AgentActor — Finding #1 guard: an actor with NO task handler must NOT
 * silently subscribe and discard tasks. It must fail loudly on start().
 *
 * Before the gateway/worker split, handler-less actors built in the gateway
 * entrypoint subscribed to `kaiban-agents-{id}` and competed with real worker
 * nodes, silently dropping (delay(50); return null) every task they won.
 *
 * Guard (master plan §B8 Phase 1.1 — "no-silent-discard"; invariant adjacent):
 *   - start() throws when no handler was provided
 *   - the driver is NEVER subscribed in that case (no task can be won/dropped)
 *   - a handler-backed actor starts and subscribes exactly as before
 */
import { describe, it, expect, vi } from "vitest";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/shared/structured-logger", () => ({
  createStructuredLogger: (): typeof mockLog => mockLog,
  logger: mockLog,
  resolveLogLevel: (): string => "silent",
}));

import { AgentActor } from "../../../src/application/actor/AgentActor";
import type { IMessagingDriver } from "../../../src/infrastructure/messaging/interfaces";

function makeMockDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AgentActor — requires a task handler (no silent discard)", () => {
  it("start() throws when constructed without a task handler", async () => {
    const d = makeMockDriver();
    const actor = new AgentActor("agent-1", d, "q");
    await expect(actor.start()).rejects.toThrow(/task handler/i);
  });

  it("does NOT subscribe to the queue when no handler is provided", async () => {
    const d = makeMockDriver();
    const actor = new AgentActor("agent-1", d, "q");
    await actor.start().catch(() => undefined);
    expect(d.subscribe).not.toHaveBeenCalled();
  });

  it("start() throws when handler is explicitly undefined", async () => {
    const d = makeMockDriver();
    const actor = new AgentActor("agent-1", d, "q", undefined);
    await expect(actor.start()).rejects.toThrow(/task handler/i);
  });

  it("the thrown error never leaks the raw (un-hashed) agent id", async () => {
    const d = makeMockDriver();
    const rawId = "super-secret-agent-id";
    const actor = new AgentActor(rawId, d, "q");
    const err = await actor
      .start()
      .then(() => undefined)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(rawId);
  });

  it("a handler-backed actor starts and subscribes normally", async () => {
    const d = makeMockDriver();
    const actor = new AgentActor("agent-1", d, "q", vi.fn());
    await actor.start();
    expect(d.subscribe).toHaveBeenCalledWith("q", expect.any(Function));
  });
});
