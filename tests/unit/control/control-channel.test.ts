/**
 * The `kaiban-control` channel (roadmap §6.10, ADR-025): the STOP_ALL command
 * schema, issuing (stop moment saved in Redis, then a signed publish), reading
 * the saved stop, and the subscriber every node runs (ES-3, ES-6, ES-11).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

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

type Listener = (...args: unknown[]) => void;
interface FakeRedis {
  listeners: Map<string, Listener[]>;
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}
const instances = vi.hoisted(() => [] as FakeRedis[]);
const stored = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    const r: FakeRedis = {
      listeners: new Map(),
      on: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(1),
      get: vi.fn(async () => stored.value),
      quit: vi.fn().mockResolvedValue("OK"),
      emit: (event, ...args) => r.listeners.get(event)?.forEach((l) => l(...args)),
    };
    r.on.mockImplementation((event: string, l: Listener) => {
      r.listeners.set(event, [...(r.listeners.get(event) ?? []), l]);
      return r;
    });
    instances.push(r);
    return r;
  }),
}));

import {
  ControlSubscriber,
  STOP_MOMENT_KEY,
  issueStopAll,
  parseStopAllCommand,
  readLastStop,
  type ControlPublisher,
  type ControlReader,
  type StopAllCommand,
} from "../../../src/infrastructure/control/control-channel";
import { CONTROL_CHANNEL } from "../../../src/infrastructure/messaging/channels";
import { wrapSigned } from "../../../src/infrastructure/security/channel-signing";

const cmd = (over: Partial<StopAllCommand> = {}): StopAllCommand => ({
  commandId: "c-1",
  command: "STOP_ALL",
  issuedBy: "operator",
  issuedAt: 1_700_000_000_000,
  ...over,
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  instances.length = 0;
  stored.value = null;
  delete process.env["CHANNEL_SIGNING_SECRET"];
});
afterEach(() => {
  delete process.env["CHANNEL_SIGNING_SECRET"];
});

describe("parseStopAllCommand", () => {
  it("accepts a well-formed command, with or without a reason", () => {
    expect(parseStopAllCommand(cmd())).toEqual(cmd());
    expect(parseStopAllCommand(cmd({ reason: "runaway" }))).toEqual(cmd({ reason: "runaway" }));
  });

  it.each([
    ["a missing commandId", { ...cmd(), commandId: undefined }],
    ["another command", { ...cmd(), command: "PAUSE" }],
    ["an empty issuer", cmd({ issuedBy: "" })],
    ["a non-integer moment", cmd({ issuedAt: 1.5 })],
    ["a zero moment", cmd({ issuedAt: 0 })],
    ["a reason over 500 chars", cmd({ reason: "x".repeat(501) })],
    ["an unknown field", { ...cmd(), extra: 1 }],
    ["null", null],
    ["a string", "STOP_ALL"],
  ])("rejects %s", (_label, value) => {
    expect(parseStopAllCommand(value)).toBeNull();
  });
});

describe("issueStopAll", () => {
  const redis = (): {
    eval: Mock<ControlPublisher["eval"]>;
    publish: Mock<ControlPublisher["publish"]>;
  } => ({
    eval: vi.fn<ControlPublisher["eval"]>().mockResolvedValue(1),
    publish: vi.fn<ControlPublisher["publish"]>().mockResolvedValue(1),
  });

  it("saves the stop if it is the latest, then publishes it signed on the control channel", async () => {
    process.env["CHANNEL_SIGNING_SECRET"] = "s".repeat(32);
    const r = redis();
    const order: string[] = [];
    r.eval.mockImplementation(async () => (order.push("eval"), 1));
    r.publish.mockImplementation(async () => (order.push("publish"), 1));

    await expect(issueStopAll(r, cmd())).resolves.toEqual({ saved: true });

    expect(order).toEqual(["eval", "publish"]);
    expect(r.eval).toHaveBeenCalledWith(
      expect.stringContaining("cjson.decode"),
      1,
      STOP_MOMENT_KEY,
      String(cmd().issuedAt),
      JSON.stringify(cmd()),
    );
    const [channel, msg] = r.publish.mock.calls[0] as [string, string];
    expect(channel).toBe(CONTROL_CHANNEL);
    expect(JSON.parse(msg)).toMatchObject({ payload: cmd(), sig: expect.any(String) });
  });

  it("still publishes when a later stop is already saved (saved: false)", async () => {
    const r = redis();
    r.eval.mockResolvedValue(0);
    await expect(issueStopAll(r, cmd())).resolves.toEqual({ saved: false });
    expect(r.publish).toHaveBeenCalledOnce();
  });

  it("rejects an invalid command before touching Redis", async () => {
    const r = redis();
    await expect(issueStopAll(r, cmd({ issuedBy: "" }))).rejects.toThrow(
      "Invalid STOP_ALL command",
    );
    expect(r.eval).not.toHaveBeenCalled();
    expect(r.publish).not.toHaveBeenCalled();
  });
});

describe("readLastStop", () => {
  const reader = (value: string | null): { get: Mock<ControlReader["get"]> } => ({
    get: vi.fn<ControlReader["get"]>().mockResolvedValue(value),
  });

  it("returns the saved command", async () => {
    await expect(readLastStop(reader(JSON.stringify(cmd())))).resolves.toEqual(cmd());
  });

  it("returns null when nothing is saved, or the value is not JSON or not a command", async () => {
    await expect(readLastStop(reader(null))).resolves.toBeNull();
    await expect(readLastStop(reader("{not json"))).resolves.toBeNull();
    await expect(readLastStop(reader(JSON.stringify({ a: 1 })))).resolves.toBeNull();
  });
});

describe("ControlSubscriber", () => {
  it("subscribes to the control channel and delivers each valid signed command", async () => {
    process.env["CHANNEL_SIGNING_SECRET"] = "s".repeat(32);
    const onStop = vi.fn();
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop });
    await sub.start();

    const [subscriber] = instances;
    expect(subscriber!.subscribe).toHaveBeenCalledWith(CONTROL_CHANNEL);
    subscriber!.emit("message", CONTROL_CHANNEL, wrapSigned(cmd()));
    expect(onStop).toHaveBeenCalledWith(cmd(), "channel");
    await sub.close();
  });

  it("ignores and logs a message whose signature does not verify (ES-6)", async () => {
    process.env["CHANNEL_SIGNING_SECRET"] = "s".repeat(32);
    const onStop = vi.fn();
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop });
    await sub.start();

    instances[0]!.emit("message", CONTROL_CHANNEL, JSON.stringify(cmd())); // unsigned
    expect(onStop).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.anything(),
      "Ignored a control message that is unsigned or fails verification",
    );
    await sub.close();
  });

  it("ignores and logs a verified message that is not a STOP_ALL command", async () => {
    const onStop = vi.fn();
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop });
    await sub.start();

    instances[0]!.emit("message", CONTROL_CHANNEL, JSON.stringify({ command: "PAUSE" }));
    expect(onStop).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.anything(),
      "Ignored an invalid control command",
    );
    await sub.close();
  });

  it("reads the saved stop at start and on every reconnect (ES-3)", async () => {
    stored.value = JSON.stringify(cmd());
    const onStop = vi.fn();
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop });
    await sub.start();
    expect(onStop).toHaveBeenCalledWith(cmd(), "saved");

    stored.value = JSON.stringify(cmd({ commandId: "c-2", issuedAt: cmd().issuedAt + 1 }));
    instances[0]!.emit("ready");
    await flush();
    expect(onStop).toHaveBeenLastCalledWith(
      cmd({ commandId: "c-2", issuedAt: cmd().issuedAt + 1 }),
      "saved",
    );
    await sub.close();
  });

  it("does nothing at start when no stop is saved", async () => {
    const onStop = vi.fn();
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop });
    await sub.start();
    expect(onStop).not.toHaveBeenCalled();
    await sub.close();
  });

  it("logs a failed read of the saved stop and keeps running", async () => {
    const onStop = vi.fn();
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop });
    await sub.start();
    instances[1]!.get.mockRejectedValueOnce(new Error("down"));
    instances[0]!.emit("ready");
    await flush();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Could not read the saved emergency stop",
    );
    await sub.close();
  });

  it("logs Redis connection errors on either client", async () => {
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop: vi.fn() });
    await sub.start();
    instances[0]!.emit("error", new Error("boom"));
    instances[1]!.emit("error", new Error("boom"));
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
    await sub.close();
  });

  it("close() quits both connections, and is safe before start()", async () => {
    const idle = new ControlSubscriber({ redisUrl: "redis://x", onStop: vi.fn() });
    await idle.close();
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop: vi.fn() });
    await sub.start();
    await sub.close();
    expect(instances[0]!.quit).toHaveBeenCalledOnce();
    expect(instances[1]!.quit).toHaveBeenCalledOnce();
  });

  it("a callback that throws is logged, not raised into ioredis", async () => {
    const onStop = vi.fn(() => {
      throw new Error("handler bug");
    });
    const sub = new ControlSubscriber({ redisUrl: "redis://x", onStop });
    await sub.start();
    instances[0]!.emit("message", CONTROL_CHANNEL, JSON.stringify(cmd()));
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Emergency stop handler failed",
    );
    await sub.close();
  });
});
