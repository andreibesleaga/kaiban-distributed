/**
 * GatewayApp — final-audit fixes: per-route socket timeouts (long A2A/MCP
 * requests survive), body parsing after the rate limit, JSON errors instead of
 * an HTML stack trace, STOP ALL outside the shared bucket.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { IncomingMessage } from "http";
import request from "supertest";
import { GatewayApp } from "../../../src/adapters/gateway/GatewayApp";
import {
  DEFAULT_LONG_REQUEST_TIMEOUT_MS,
  longRequestTimeoutFor,
} from "../../../src/adapters/gateway/request-timeouts";
import type { EmergencyStopIngress } from "../../../src/adapters/gateway/emergency-stop-ingress";
import type { McpHttpHandler } from "../../../src/infrastructure/federation/mcp-http";
import { makeRequestHandler, makeStatusTracker } from "./gateway-test-helpers";

const mcp = (): McpHttpHandler =>
  ({
    handlePost: vi.fn((_q, res) => Promise.resolve(void res.status(200).json({}))),
    handleSession: vi.fn((_q, res) => Promise.resolve(void res.status(200).json({}))),
    sessionCount: vi.fn(() => 0),
    close: vi.fn(() => Promise.resolve()),
  }) as unknown as McpHttpHandler;

const control = (): { stopAll: ReturnType<typeof vi.fn> } => ({
  stopAll: vi.fn().mockResolvedValue({ ok: true, commandId: "c", issuedAt: 1, saved: true }),
});

const build = (extra: Record<string, unknown> = {}): GatewayApp =>
  new GatewayApp({
    requestHandler: makeRequestHandler(),
    statusTracker: makeStatusTracker() as never,
    ...extra,
  });

afterEach(() => vi.restoreAllMocks());

describe("socket idle timeout per route (SEC-02)", () => {
  it("A2A and MCP routes get the long limit; stop-all keeps 30 s", async () => {
    const spy = vi.spyOn(IncomingMessage.prototype, "setTimeout");
    const gw = build({ mcpHandler: mcp(), emergencyStop: control() as unknown as EmergencyStopIngress });
    const rpc = { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "t-1" } };
    await request(gw.app).post("/a2a/rpc").send(rpc);
    await request(gw.app).post("/mcp").send({});
    await request(gw.app).get("/mcp");
    await request(gw.app).post("/control/stop-all").send({});
    const values = spy.mock.calls.map((c) => c[0]);
    expect(values.filter((v) => v === DEFAULT_LONG_REQUEST_TIMEOUT_MS)).toHaveLength(3);
    expect(values.filter((v) => v === 30_000)).toHaveLength(1);
    expect(DEFAULT_LONG_REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("longRequestTimeoutMs overrides the default", async () => {
    const spy = vi.spyOn(IncomingMessage.prototype, "setTimeout");
    const gw = build({ longRequestTimeoutMs: 123_456 });
    await request(gw.app).post("/a2a/rpc").send({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "t" } });
    expect(spy).toHaveBeenCalledWith(123_456);
  });
});

describe("longRequestTimeoutFor", () => {
  it("is at least 15 minutes and always beyond the task wait", () => {
    expect(longRequestTimeoutFor(1_000)).toBe(DEFAULT_LONG_REQUEST_TIMEOUT_MS);
    expect(longRequestTimeoutFor(2_000_000)).toBe(2_060_000);
  });
});

describe("body parsing and errors (SEC-10)", () => {
  it("a malformed A2A body gets a short JSON 400, no stack trace", async () => {
    const res = await request(build().app)
      .post("/a2a/rpc")
      .set("content-type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual({ data: null, meta: {}, errors: [{ message: "Bad Request" }] });
    expect(res.text).not.toMatch(/SyntaxError|node_modules/);
  });

  it("an oversized body is a JSON 413", async () => {
    const res = await request(build().app)
      .post("/a2a/rpc")
      .set("content-type", "application/json")
      .send(JSON.stringify({ pad: "x".repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.errors[0].message).toBe("Payload Too Large");
  });

  it("the stop-all body is capped at 16 kB", async () => {
    const gw = build({ emergencyStop: control() as unknown as EmergencyStopIngress });
    const res = await request(gw.app)
      .post("/control/stop-all")
      .set("content-type", "application/json")
      .send(JSON.stringify({ reason: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it("an unexpected error is a JSON 500 and is logged", async () => {
    const gw = build();
    const handler = (gw as unknown as {
      handleError: (e: unknown, q: unknown, r: unknown, n: unknown) => void;
    }).handleError.bind(gw);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    handler(new Error("boom"), {}, res, vi.fn());
    handler(null, {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ data: null, meta: {}, errors: [{ message: "Internal Server Error" }] });
  });

  it("another body-parser client error (415) keeps its status instead of becoming a 500", async () => {
    const gw = build();
    const handler = (gw as unknown as {
      handleError: (e: unknown, q: unknown, r: unknown, n: unknown) => void;
    }).handleError.bind(gw);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    handler(Object.assign(new Error("unsupported"), { status: 415 }), {}, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(415);
    expect(res.json).toHaveBeenCalledWith({ data: null, meta: {}, errors: [{ message: "Bad Request" }] });
  });

  it("unknown paths are rate-limited too (no free 1 MB parsing, no free probing)", async () => {
    const gw = build();
    let last = 0;
    for (let i = 0; i < 101; i++) last = (await request(gw.app).post("/nope").send({ a: 1 })).status;
    expect(last).toBe(429);
  });
});

describe("POST /control/stop-all is outside the shared 100/min bucket (SEC-03)", () => {
  it("other traffic from the same address cannot starve it", async () => {
    const ctl = control();
    const gw = build({ emergencyStop: ctl as unknown as EmergencyStopIngress });
    for (let i = 0; i < 105; i++) await request(gw.app).get("/a2a/agents/writer/status");
    const res = await request(gw.app).post("/control/stop-all").send({});
    expect(res.status).toBe(202);
    expect(ctl.stopAll).toHaveBeenCalledTimes(1);
  });
});

describe("a silent blocking request on a real socket (SEC-02)", () => {
  const send = { jsonrpc: "2.0", id: 1, method: "message/send", params: {
    message: { kind: "message", messageId: "m", role: "user", parts: [{ kind: "text", text: "hi" }] },
  } };
  const call = async (limitMs: number, taskMs: number): Promise<number | string> => {
    const requestHandler = makeRequestHandler({
      sendMessage: vi.fn(
        () => new Promise((r) => setTimeout(() => r({ kind: "task", id: "t", contextId: "c", status: { state: "completed" } }), taskMs)),
      ),
    } as never);
    const gw = new GatewayApp({ requestHandler, statusTracker: makeStatusTracker() as never, longRequestTimeoutMs: limitMs });
    const server = gw.app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/a2a/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(send),
      });
      return res.status;
    } catch {
      return "closed";
    } finally {
      server.closeAllConnections();
      server.close();
    }
  };

  it("answers a silent task that finishes inside the configured limit", async () => {
    expect(await call(2_000, 300)).toBe(200);
  });

  it("is still cut when the task outlasts the configured limit", async () => {
    expect(await call(100, 600)).toBe("closed");
  });
});
