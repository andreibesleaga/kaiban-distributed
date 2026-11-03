/**
 * The gateway's emergency STOP ALL ingress (roadmap §6.10 ES-6, ES-9, ES-10;
 * ADR-025): board token always required, 5 commands per 10 s per client, the
 * stop saved + published, an `issued` ack on the state channel.
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

import { EmergencyStopIngress } from "../../../src/adapters/gateway/emergency-stop-ingress";
import { issueBoardToken } from "../../../src/infrastructure/security/board-auth";
import {
  CONTROL_CHANNEL,
  STATE_CHANNEL,
} from "../../../src/infrastructure/messaging/channels";
import { STOP_MOMENT_KEY } from "../../../src/infrastructure/control/control-channel";

type Redis = {
  eval: Mock<(script: string, numKeys: number, ...args: string[]) => Promise<unknown>>;
  publish: Mock<(channel: string, message: string) => Promise<number>>;
  get: Mock<(key: string) => Promise<string | null>>;
};
const fakeRedis = (): Redis => ({
  eval: vi.fn<Redis["eval"] extends Mock<infer F> ? F : never>().mockResolvedValue(1),
  publish: vi.fn<Redis["publish"] extends Mock<infer F> ? F : never>().mockResolvedValue(1),
  get: vi.fn<Redis["get"] extends Mock<infer F> ? F : never>().mockResolvedValue(null),
});

const SECRET = "b".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  process.env["BOARD_JWT_SECRET"] = SECRET;
});
afterEach(() => {
  delete process.env["BOARD_JWT_SECRET"];
});

describe("EmergencyStopIngress.stopAll", () => {
  it("refuses every command when BOARD_JWT_SECRET is unset, even with a token (401)", async () => {
    const token = issueBoardToken("ops");
    delete process.env["BOARD_JWT_SECRET"];
    const redis = fakeRedis();
    const ingress = new EmergencyStopIngress(redis);
    await expect(ingress.stopAll(token, {}, "ip-1")).resolves.toEqual({
      ok: false,
      status: 401,
      error: "Emergency stop needs board authentication (BOARD_JWT_SECRET)",
    });
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("refuses a missing or invalid token (401) and publishes nothing", async () => {
    const redis = fakeRedis();
    const ingress = new EmergencyStopIngress(redis);
    await expect(ingress.stopAll(undefined, {}, "ip")).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "Missing board token",
    });
    await expect(ingress.stopAll("not-a-jwt", {}, "ip")).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "Invalid or expired board token",
    });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("rejects a reason that is not a string of at most 500 chars (400)", async () => {
    const ingress = new EmergencyStopIngress(fakeRedis());
    const token = issueBoardToken("ops");
    for (const body of [{ reason: 5 }, { reason: "x".repeat(501) }]) {
      await expect(ingress.stopAll(token, body, "ip")).resolves.toMatchObject({
        ok: false,
        status: 400,
        error: "reason must be a string of at most 500 characters",
      });
    }
  });

  it("issues the stop with the token subject, saves it, publishes it, acks it as issued, logs it", async () => {
    const redis = fakeRedis();
    const ingress = new EmergencyStopIngress(redis, { now: (): number => 7_000 });
    const result = await ingress.stopAll(issueBoardToken("ops@site"), { reason: "runaway" }, "ip");

    expect(result).toEqual({
      ok: true,
      commandId: expect.any(String),
      issuedAt: 7_000,
      saved: true,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      STOP_MOMENT_KEY,
      "7000",
      expect.stringContaining('"issuedBy":"ops@site"'),
    );
    expect(redis.publish).toHaveBeenCalledWith(CONTROL_CHANNEL, expect.any(String));
    const stateMsg = redis.publish.mock.calls.find((c) => c[0] === STATE_CHANNEL)?.[1];
    expect(JSON.parse(stateMsg!)).toEqual({
      control: {
        commandId: (result as { commandId: string }).commandId,
        issuedAt: 7_000,
        issuedBy: "ops@site",
        reason: "runaway",
        nodeId: "gateway",
        outcome: "issued",
        aborted: 0,
        at: 7_000,
      },
    });
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "ops@site", reason: "runaway" }),
      "Emergency STOP ALL issued",
    );
  });

  it("a token without a string subject issues as `board`; a missing body is fine", async () => {
    const redis = fakeRedis();
    const ingress = new EmergencyStopIngress(redis, { now: (): number => 1 });
    const jwt = await import("jsonwebtoken");
    const noSub = jwt.default.sign({ role: "board-viewer" }, SECRET, { algorithm: "HS256" });
    await expect(ingress.stopAll(noSub, undefined, "ip")).resolves.toMatchObject({ ok: true });
    expect(redis.eval.mock.calls[0]![4]).toContain('"issuedBy":"board"');
  });

  it("allows 5 commands per 10 s per client, then 429 (ES-10)", async () => {
    const ingress = new EmergencyStopIngress(fakeRedis());
    const token = issueBoardToken("ops");
    for (let i = 0; i < 5; i++) {
      await expect(ingress.stopAll(token, {}, "ip-a")).resolves.toMatchObject({ ok: true });
    }
    await expect(ingress.stopAll(token, {}, "ip-a")).resolves.toEqual({
      ok: false,
      status: 429,
      error: "Too Many Requests",
    });
    await expect(ingress.stopAll(token, {}, "ip-b")).resolves.toMatchObject({ ok: true });
  });

  it("a Redis failure is a 500 and nothing is acked", async () => {
    const redis = fakeRedis();
    redis.eval.mockRejectedValue(new Error("down"));
    const ingress = new EmergencyStopIngress(redis);
    await expect(ingress.stopAll(issueBoardToken("ops"), {}, "ip")).resolves.toEqual({
      ok: false,
      status: 500,
      error: "Redis write failed",
    });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it("a failed `issued` ack publish is logged; the stop still succeeds", async () => {
    const redis = fakeRedis();
    redis.publish.mockImplementation(async (channel) => {
      if (channel === STATE_CHANNEL) throw new Error("pub failed");
      return 1;
    });
    const ingress = new EmergencyStopIngress(redis);
    await expect(ingress.stopAll(issueBoardToken("ops"), {}, "ip")).resolves.toMatchObject({
      ok: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to publish the emergency stop ack",
    );
  });
});
