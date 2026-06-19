/**
 * Gateway MCP routes (master plan §B5.1 Phase M, ADR-017).
 *
 * When an `mcpHandler` is supplied, the gateway mounts POST/GET/DELETE at
 * `mcpPath` behind the SAME security chain as A2A (rate-limit → env-gated JWT →
 * timeout). POST opens/uses a session, GET streams notifications, DELETE
 * terminates. When no handler is supplied the surface is absent (404).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { GatewayApp } from "../../../src/adapters/gateway/GatewayApp";
import type { McpHttpHandler } from "../../../src/infrastructure/federation/mcp-http";
import { makeRequestHandler, makeStatusTracker } from "./gateway-test-helpers";

function makeMcpHandler(): McpHttpHandler {
  return {
    handlePost: vi.fn((_req, res) => {
      res.status(200).json({ ok: "post" });
      return Promise.resolve();
    }),
    handleSession: vi.fn((_req, res) => {
      res.status(202).json({ ok: "session" });
      return Promise.resolve();
    }),
    sessionCount: vi.fn(() => 0),
    close: vi.fn(() => Promise.resolve()),
  } as unknown as McpHttpHandler;
}

function gatewayWith(handler?: McpHttpHandler, mcpPath?: string): GatewayApp {
  return new GatewayApp({
    requestHandler: makeRequestHandler(),
    statusTracker: makeStatusTracker() as never,
    ...(handler ? { mcpHandler: handler } : {}),
    ...(mcpPath ? { mcpPath } : {}),
  });
}

describe("GatewayApp MCP surface", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env["A2A_JWT_SECRET"];
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("routes POST /mcp to handlePost with the parsed body", async () => {
    const handler = makeMcpHandler();
    const res = await request(gatewayWith(handler).app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });

    expect(res.status).toBe(200);
    expect(handler.handlePost).toHaveBeenCalledTimes(1);
    const [, , body] = (handler.handlePost as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(body).toMatchObject({ method: "initialize" });
  });

  it("routes GET and DELETE /mcp to handleSession", async () => {
    const handler = makeMcpHandler();
    const gw = gatewayWith(handler);

    const getRes = await request(gw.app).get("/mcp");
    expect(getRes.status).toBe(202);
    const delRes = await request(gw.app).delete("/mcp");
    expect(delRes.status).toBe(202);
    expect(handler.handleSession).toHaveBeenCalledTimes(2);
  });

  it("mounts the surface at a custom mcpPath", async () => {
    const handler = makeMcpHandler();
    const res = await request(gatewayWith(handler, "/federation/mcp").app)
      .post("/federation/mcp")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });
    expect(res.status).toBe(200);
    expect(handler.handlePost).toHaveBeenCalledTimes(1);
  });

  it("enforces the JWT chain in front of the MCP route when configured", async () => {
    process.env["A2A_JWT_SECRET"] = "secret";
    const handler = makeMcpHandler();
    const res = await request(gatewayWith(handler).app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });

    expect(res.status).toBe(401);
    expect(handler.handlePost).not.toHaveBeenCalled();
  });

  it("does not expose /mcp when no handler is provided", async () => {
    const res = await request(gatewayWith().app).post("/mcp").send({});
    expect(res.status).toBe(404);
  });
});
