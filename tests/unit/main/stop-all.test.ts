/**
 * `npm run stop-all` — issue an emergency STOP ALL from the command line
 * (roadmap §6.10 triggers, ADR-025).
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  STOP_ALL_USAGE,
  parseStopAllArgs,
  runStopAll,
} from "../../../src/main/stop-all";
import {
  STOP_MOMENT_KEY,
  type ControlPublisher,
} from "../../../src/infrastructure/control/control-channel";
import { CONTROL_CHANNEL } from "../../../src/infrastructure/messaging/channels";

describe("parseStopAllArgs", () => {
  it("defaults the issuer to $USER, else `cli`, with no reason", () => {
    expect(parseStopAllArgs([], { USER: "ana" })).toEqual({ by: "ana" });
    expect(parseStopAllArgs([], {})).toEqual({ by: "cli" });
  });

  it("reads --reason and --by, as separate or `=` values", () => {
    expect(parseStopAllArgs(["--reason", "runaway loop", "--by", "ops"], {})).toEqual({
      by: "ops",
      reason: "runaway loop",
    });
    expect(parseStopAllArgs(["--reason=cost", "--by=oncall"], {})).toEqual({
      by: "oncall",
      reason: "cost",
    });
  });

  it("recognises --help", () => {
    expect(parseStopAllArgs(["--help"], {})).toEqual({ by: "cli", help: true });
    expect(parseStopAllArgs(["-h"], {})).toEqual({ by: "cli", help: true });
  });

  it.each([
    [["--reason"], "--reason needs a value"],
    [["--by", ""], "--by needs a value"],
    [["--bogus"], "Unknown argument: --bogus"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseStopAllArgs(argv, {})).toThrow(message);
  });
});

describe("runStopAll", () => {
  type FakeRedis = {
    eval: Mock<ControlPublisher["eval"]>;
    publish: Mock<ControlPublisher["publish"]>;
    quit: Mock<() => Promise<unknown>>;
  };
  const fakeRedis = (): FakeRedis => ({
    eval: vi.fn<ControlPublisher["eval"]>().mockResolvedValue(1),
    publish: vi.fn<ControlPublisher["publish"]>().mockResolvedValue(3),
    quit: vi.fn<() => Promise<unknown>>().mockResolvedValue("OK"),
  });

  it("issues the stop, prints its id and moment, and closes Redis", async () => {
    const redis = fakeRedis();
    const out = vi.fn();
    const code = await runStopAll(["--reason", "runaway"], {
      env: { USER: "ana", REDIS_URL: "redis://r:6379" },
      connect: (url) => {
        expect(url).toBe("redis://r:6379");
        return redis;
      },
      now: () => 1_234,
      out,
    });

    expect(code).toBe(0);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      STOP_MOMENT_KEY,
      "1234",
      expect.stringContaining('"issuedBy":"ana"'),
    );
    expect(redis.publish).toHaveBeenCalledWith(CONTROL_CHANNEL, expect.any(String));
    const printed = JSON.parse(out.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(printed).toEqual({
      commandId: expect.any(String),
      issuedAt: 1_234,
      issuedBy: "ana",
      reason: "runaway",
      saved: true,
    });
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it("uses redis://localhost:6379 by default", async () => {
    const connect = vi.fn((_url: string) => fakeRedis());
    await runStopAll([], { env: {}, connect, now: () => 1, out: vi.fn() });
    expect(connect).toHaveBeenCalledWith("redis://localhost:6379");
  });

  it("prints usage for --help and exits 0 without connecting", async () => {
    const connect = vi.fn((_url: string) => fakeRedis());
    const out = vi.fn();
    await expect(runStopAll(["--help"], { env: {}, connect, out })).resolves.toBe(0);
    expect(out).toHaveBeenCalledWith(STOP_ALL_USAGE);
    expect(connect).not.toHaveBeenCalled();
  });

  it("a bad argument prints the error and usage, exit 1", async () => {
    const err = vi.fn();
    await expect(
      runStopAll(["--nope"], { env: {}, connect: vi.fn((_url: string) => fakeRedis()), out: vi.fn(), err }),
    ).resolves.toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Unknown argument: --nope"));
  });

  it("a Redis failure prints the error, closes Redis, exit 1", async () => {
    const redis = fakeRedis();
    redis.eval.mockRejectedValue(new Error("ECONNREFUSED"));
    const err = vi.fn();
    await expect(
      runStopAll([], { env: {}, connect: () => redis, out: vi.fn(), err }),
    ).resolves.toBe(1);
    expect(err).toHaveBeenCalledWith("stop-all failed: ECONNREFUSED");
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it("reports a non-Error failure too, and survives a failing quit", async () => {
    const redis = fakeRedis();
    redis.eval.mockRejectedValue("boom");
    redis.quit.mockRejectedValue(new Error("closed"));
    const err = vi.fn();
    await expect(
      runStopAll([], { env: {}, connect: () => redis, out: vi.fn(), err }),
    ).resolves.toBe(1);
    expect(err).toHaveBeenCalledWith("stop-all failed: boom");
  });

  it("defaults now, out and err to the real ones", async () => {
    const redis = fakeRedis();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runStopAll([], { env: {}, connect: () => redis })).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runStopAll(["--x"], { env: {}, connect: () => redis })).resolves.toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("warns on stderr when CHANNEL_SIGNING_SECRET is not set, but still issues the stop", async () => {
    const err = vi.fn();
    const redis = fakeRedis();
    await expect(
      runStopAll([], { env: {}, connect: () => redis, out: vi.fn(), err }),
    ).resolves.toBe(0);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("CHANNEL_SIGNING_SECRET is not set"));
  });

  it("does not warn when CHANNEL_SIGNING_SECRET is set", async () => {
    const err = vi.fn();
    await runStopAll([], {
      env: { CHANNEL_SIGNING_SECRET: "s".repeat(32) },
      connect: () => fakeRedis(),
      out: vi.fn(),
      err,
    });
    expect(err).not.toHaveBeenCalled();
  });
});
