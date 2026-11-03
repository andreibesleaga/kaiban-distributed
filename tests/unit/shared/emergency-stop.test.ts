/**
 * Shared emergency STOP ALL helpers (roadmap §6.10, ADR-025): the env switch,
 * building a command, wiring a worker's actor to the control channel (ES-1,
 * ES-3, ES-9) and the stop signal an orchestrator waits on (ES-4).
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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

type OnStop = (cmd: StopAllCommand, source: "channel" | "saved") => void;
const subs = vi.hoisted(
  () => [] as { onStop: OnStop; start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
);
vi.mock("../../../src/infrastructure/control/control-channel", async (orig) => {
  const real = await orig<typeof import("../../../src/infrastructure/control/control-channel")>();
  return {
    ...real,
    ControlSubscriber: vi.fn().mockImplementation(function (opts: { onStop: OnStop }) {
      const s = {
        onStop: opts.onStop,
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      subs.push(s);
      return s;
    }),
  };
});

import {
  attachEmergencyStop,
  controlPlaneEnabled,
  createEmergencyStopSignal,
  createStopAllCommand,
} from "../../../src/shared/emergency-stop";
import type {
  ControlAck,
  StopAllCommand,
} from "../../../src/infrastructure/control/control-channel";
import type { EmergencyStopResult } from "../../../src/application/actor/AgentActor";
import { EmergencyStopError } from "../../../src/domain/errors/DomainError";

const cmd = (over: Partial<StopAllCommand> = {}): StopAllCommand => ({
  commandId: "c-1",
  command: "STOP_ALL",
  issuedBy: "operator",
  issuedAt: 5_000,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  subs.length = 0;
});

describe("controlPlaneEnabled", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["TRUE", false],
    ["yes", false],
    ["", false],
    [undefined, false],
  ])("CONTROL_PLANE_ENABLED=%s → %s", (value, expected) => {
    const env = value === undefined ? {} : { CONTROL_PLANE_ENABLED: value };
    expect(controlPlaneEnabled(env)).toBe(expected);
  });

  it("reads process.env by default", () => {
    const before = process.env["CONTROL_PLANE_ENABLED"];
    process.env["CONTROL_PLANE_ENABLED"] = "true";
    expect(controlPlaneEnabled()).toBe(true);
    if (before === undefined) delete process.env["CONTROL_PLANE_ENABLED"];
    else process.env["CONTROL_PLANE_ENABLED"] = before;
  });
});

describe("createStopAllCommand", () => {
  it("builds a valid STOP_ALL with a fresh id and the given moment", () => {
    const c = createStopAllCommand("ops@example", "runaway", 42);
    expect(c).toEqual({
      commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      command: "STOP_ALL",
      issuedBy: "ops@example",
      issuedAt: 42,
      reason: "runaway",
    });
    expect(createStopAllCommand("x", undefined, 1)).not.toHaveProperty("reason");
    expect(createStopAllCommand("x").issuedAt).toBeGreaterThan(0);
    expect(createStopAllCommand("x").commandId).not.toBe(createStopAllCommand("x").commandId);
  });
});

describe("attachEmergencyStop (worker)", () => {
  const actor = (
    result: EmergencyStopResult = { outcome: "applied", aborted: 1 },
  ): { emergencyStop: Mock<(at: number) => EmergencyStopResult> } => ({
    emergencyStop: vi.fn<(at: number) => EmergencyStopResult>().mockReturnValue(result),
  });
  const publisher = (): { publishControlAck: Mock<(ack: ControlAck) => void> } => ({
    publishControlAck: vi.fn<(ack: ControlAck) => void>(),
  });

  it("starts a subscriber; a channel command stops the actor at the command's moment and is acked", async () => {
    const a = actor();
    const p = publisher();
    const handle = await attachEmergencyStop({
      actor: a,
      publisher: p,
      redisUrl: "redis://x",
      agentId: "writer",
      nodeId: "host:7",
      now: () => 9_000,
    });
    expect(subs[0]!.start).toHaveBeenCalledOnce();

    subs[0]!.onStop(cmd({ reason: "runaway" }), "channel");
    expect(a.emergencyStop).toHaveBeenCalledWith(5_000);
    expect(p.publishControlAck).toHaveBeenCalledWith({
      commandId: "c-1",
      issuedAt: 5_000,
      issuedBy: "operator",
      reason: "runaway",
      nodeId: "host:7",
      agentId: "writer",
      outcome: "applied",
      aborted: 1,
      at: 9_000,
    });

    await handle.close();
    expect(subs[0]!.close).toHaveBeenCalledOnce();
  });

  it("a noop is acked too (ES-8)", async () => {
    const a = actor({ outcome: "noop", aborted: 0 });
    const p = publisher();
    await attachEmergencyStop({ actor: a, publisher: p, redisUrl: "r", agentId: "w" });
    subs[0]!.onStop(cmd(), "channel");
    expect(p.publishControlAck).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "noop", aborted: 0, nodeId: expect.any(String) }),
    );
  });

  it("a saved stop read at start is applied, but acked only when it killed a task", async () => {
    const quiet = actor({ outcome: "applied", aborted: 0 });
    const p = publisher();
    await attachEmergencyStop({ actor: quiet, publisher: p, redisUrl: "r", agentId: "w" });
    subs[0]!.onStop(cmd(), "saved");
    expect(quiet.emergencyStop).toHaveBeenCalledWith(5_000);
    expect(p.publishControlAck).not.toHaveBeenCalled();

    const busy = actor({ outcome: "applied", aborted: 2 });
    await attachEmergencyStop({ actor: busy, publisher: p, redisUrl: "r", agentId: "w" });
    subs[1]!.onStop(cmd(), "saved");
    expect(p.publishControlAck).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: 2 }),
    );
  });

  it("works without a publisher (no ack)", async () => {
    const a = actor();
    await attachEmergencyStop({ actor: a, redisUrl: "r", agentId: "w" });
    subs[0]!.onStop(cmd(), "channel");
    expect(a.emergencyStop).toHaveBeenCalledOnce();
  });
});

describe("createEmergencyStopSignal (orchestrator)", () => {
  it("aborts with EmergencyStopError for a stop at or after the orchestrator's start", async () => {
    const stop = await createEmergencyStopSignal("redis://x", 5_000);
    expect(stop.signal.aborted).toBe(false);
    subs[0]!.onStop(cmd({ issuedAt: 5_000, reason: "runaway" }), "channel");
    expect(stop.signal.aborted).toBe(true);
    expect(stop.signal.reason).toBeInstanceOf(EmergencyStopError);
    expect((stop.signal.reason as Error).message).toBe("Emergency stop: runaway");
    await stop.close();
    expect(subs[0]!.close).toHaveBeenCalledOnce();
  });

  it("ignores a saved stop from before its start (an old stop never ends a new run)", async () => {
    const stop = await createEmergencyStopSignal("redis://x", 6_000);
    subs[0]!.onStop(cmd({ issuedAt: 5_000 }), "saved");
    expect(stop.signal.aborted).toBe(false);
  });

  it("keeps the first reason when several stops arrive; defaults the start to now", async () => {
    const stop = await createEmergencyStopSignal("redis://x");
    subs[0]!.onStop(cmd({ issuedAt: Date.now() + 1_000 }), "channel");
    const first = stop.signal.reason as Error;
    subs[0]!.onStop(cmd({ issuedAt: Date.now() + 2_000, reason: "again" }), "channel");
    expect(stop.signal.reason).toBe(first);
    expect(first.message).toBe("Emergency stop");
  });
});
