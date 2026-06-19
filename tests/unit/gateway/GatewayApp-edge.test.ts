/**
 * GatewayApp — edge cases and branch coverage.
 *
 * Covers:
 *   - clientIp 'unknown' fallback (req.ip and req.socket.remoteAddress both undefined)
 *   - handleNotFound for various HTTP methods
 *   - handleHealth timestamp format + response shape
 *   - agent card route (SDK-served v0.3 card)
 *   - agent.status route
 *   - Concurrent rate limiter shared state
 *   - Request logger (finish event log)
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";

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

import { SlidingWindowRateLimiter } from "../../../src/adapters/gateway/GatewayApp";
import { makeGateway, RPC_SEND } from "./gateway-test-helpers";

// ── clientIp fallback branch ─────────────────────────────────────────────────

describe('GatewayApp — clientIp fallback (req.ip ?? req.socket.remoteAddress ?? "unknown")', () => {
  it("covers req.socket.remoteAddress fallback: uses it when req.ip is undefined", () => {
    const gw = makeGateway();
    const rateLimiter = (
      gw as unknown as { rateLimiter: SlidingWindowRateLimiter }
    ).rateLimiter;
    const spy = vi.spyOn(rateLimiter, "isAllowed").mockReturnValue(true);
    const nextFn = vi.fn();
    const mockReq = { ip: undefined, socket: { remoteAddress: "10.0.0.1" } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    (
      gw as unknown as {
        rateLimit: (req: unknown, res: unknown, next: unknown) => void;
      }
    ).rateLimit(mockReq, mockRes, nextFn);
    expect(spy).toHaveBeenCalledWith("10.0.0.1");
    expect(nextFn).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('covers "unknown" fallback: uses it when both req.ip and req.socket.remoteAddress are undefined', () => {
    const gw = makeGateway();
    const rateLimiter = (
      gw as unknown as { rateLimiter: SlidingWindowRateLimiter }
    ).rateLimiter;
    const spy = vi.spyOn(rateLimiter, "isAllowed").mockReturnValue(true);
    const nextFn = vi.fn();
    const mockReq = { ip: undefined, socket: { remoteAddress: undefined } };
    const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    (
      gw as unknown as {
        rateLimit: (req: unknown, res: unknown, next: unknown) => void;
      }
    ).rateLimit(mockReq, mockRes, nextFn);
    expect(spy).toHaveBeenCalledWith("unknown");
    spy.mockRestore();
  });

  it('rateLimit returns 429 when isAllowed returns false for "unknown" IP', () => {
    const gw = makeGateway();
    const rateLimiter = (
      gw as unknown as { rateLimiter: SlidingWindowRateLimiter }
    ).rateLimiter;
    vi.spyOn(rateLimiter, "isAllowed").mockReturnValue(false);
    const nextFn = vi.fn();
    const jsonFn = vi.fn();
    const statusFn = vi.fn().mockReturnValue({ json: jsonFn });
    const mockReq = { ip: undefined, socket: { remoteAddress: undefined } };
    (
      gw as unknown as {
        rateLimit: (req: unknown, res: unknown, next: unknown) => void;
      }
    ).rateLimit(mockReq, { status: statusFn }, nextFn);
    expect(statusFn).toHaveBeenCalledWith(429);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it('rate limiter correctly tracks "unknown" key separate from real IPs', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.isAllowed("127.0.0.1");
    limiter.isAllowed("unknown");
    const windows = (limiter as unknown as { windows: Map<string, number[]> })
      .windows;
    expect(windows.has("127.0.0.1")).toBe(true);
    expect(windows.has("unknown")).toBe(true);
    expect(windows.size).toBe(2);
  });
});

// ── Route edge cases ─────────────────────────────────────────────────────────

describe("GatewayApp — handleHealth", () => {
  it("returns a valid ISO 8601 timestamp", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/health");
    expect(res.status).toBe(200);
    const ts = res.body.data.timestamp as string;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("health response has empty errors array", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/health");
    expect(res.body.errors).toEqual([]);
  });

  it("health meta is empty object", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/health");
    expect(res.body.meta).toEqual({});
  });
});

describe("GatewayApp — agent card route", () => {
  it("returns the v0.3 agent card name and version", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("kaiban-worker");
    expect(res.body.version).toBe("2.0.0");
  });

  it("agent card includes skills array", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/.well-known/agent-card.json");
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(res.body.skills[0].id).toBe("writer");
  });
});

describe("GatewayApp — agent.status route", () => {
  it("returns the tracked status for an agent", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/a2a/agents/writer/status");
    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBe("writer");
  });
});

describe("GatewayApp — handleNotFound", () => {
  it("returns 404 for unknown GET path", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.errors[0].message).toBe("Not Found");
  });

  it("returns 404 for unknown DELETE path", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).delete("/something");
    expect(res.status).toBe(404);
  });

  it("returns 404 for root path", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/");
    expect(res.status).toBe(404);
  });
});

describe("GatewayApp — JSON-RPC route", () => {
  it("returns 200 with a jsonrpc envelope on message/send", async () => {
    const gw = makeGateway();
    const res = await request(gw.app)
      .post("/a2a/rpc")
      .set("Content-Type", "application/json")
      .send(RPC_SEND);
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.id).toBe(1);
  });
});

describe("GatewayApp — request logger", () => {
  it("logs request info after response finishes", async () => {
    mockLog.info.mockClear();
    const gw = makeGateway();
    await request(gw.app).get("/health");
    await new Promise<void>((r) => setImmediate(r));
    const logged = JSON.stringify(mockLog.info.mock.calls);
    expect(logged).toContain('"method":"GET"');
    expect(logged).toContain('"path":"/health"');
    expect(logged).toContain('"status":200');
  });

  it("request logger includes a UUID request ID", async () => {
    mockLog.info.mockClear();
    const gw = makeGateway();
    await request(gw.app).get("/health");
    await new Promise<void>((r) => setImmediate(r));
    const logged = JSON.stringify(mockLog.info.mock.calls);
    expect(logged).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});

describe("GatewayApp — concurrent rate limiting", () => {
  it("each gateway instance has an independent rate limiter", () => {
    const gw1 = makeGateway();
    const gw2 = makeGateway();
    const rl1 = (gw1 as unknown as { rateLimiter: SlidingWindowRateLimiter })
      .rateLimiter;
    for (let i = 0; i < 100; i++) rl1.isAllowed("1.2.3.4");
    const rl2 = (gw2 as unknown as { rateLimiter: SlidingWindowRateLimiter })
      .rateLimiter;
    expect(rl2.isAllowed("1.2.3.4")).toBe(true);
  });
});

describe("GatewayApp — response shape (apiOk / apiError)", () => {
  it("success response has { data, meta, errors } with empty errors", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/health");
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(res.body).toHaveProperty("errors");
    expect(res.body.errors).toHaveLength(0);
  });

  it("error response has null data and non-empty errors", async () => {
    const gw = makeGateway();
    const res = await request(gw.app).get("/nonexistent");
    expect(res.body.data).toBeNull();
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});
