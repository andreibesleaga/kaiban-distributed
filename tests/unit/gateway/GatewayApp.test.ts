import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { GatewayApp } from "../../../src/adapters/gateway/GatewayApp";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import type { AgentCard } from "@a2a-js/sdk";
import { buildAgentCard } from "../../../src/infrastructure/federation/a2a-agent-card";

const card: AgentCard = buildAgentCard({
  name: "kaiban-worker",
  version: "2.0.0",
  baseUrl: "http://localhost:3000",
  agentIds: ["writer"],
});

/** Minimal stub of the SDK request handler — only the methods the gateway routes. */
function makeHandler(overrides: Partial<A2ARequestHandler> = {}): A2ARequestHandler {
  return {
    getAgentCard: vi.fn().mockResolvedValue(card),
    sendMessage: vi.fn().mockResolvedValue({
      kind: "task",
      id: "t-1",
      contextId: "c-1",
      status: { state: "completed" },
    }),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    ...overrides,
  } as unknown as A2ARequestHandler;
}

function makeTracker(status = "EXECUTING"): { getStatus: () => string; hasSeen: () => boolean } {
  return { getStatus: () => status, hasSeen: () => true };
}

function makeGateway(handler = makeHandler(), tracker = makeTracker()): GatewayApp {
  return new GatewayApp({
    requestHandler: handler,
    statusTracker: tracker as never,
  });
}

const RPC_SEND = {
  jsonrpc: "2.0",
  id: 1,
  method: "message/send",
  params: {
    message: {
      kind: "message",
      role: "user",
      messageId: "m-1",
      parts: [{ kind: "text", text: "hi" }],
      metadata: { agentId: "writer" },
    },
  },
};

describe("GatewayApp", () => {
  let gateway: GatewayApp;
  beforeEach(() => {
    gateway = makeGateway();
  });

  it("GET /health returns 200", async () => {
    const res = await request(gateway.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
  });

  it("GET /.well-known/agent-card.json returns the v0.3 card", async () => {
    const res = await request(gateway.app).get("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("kaiban-worker");
    expect(res.body.protocolVersion).toBe("0.3.0");
  });

  it("POST /a2a/rpc message/send returns a JSON-RPC 200 result", async () => {
    const res = await request(gateway.app)
      .post("/a2a/rpc")
      .set("Content-Type", "application/json")
      .send(RPC_SEND);
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.result).toBeDefined();
  });

  it("GET /a2a/agents/:id/status returns the real tracked status", async () => {
    const res = await request(gateway.app).get("/a2a/agents/writer/status");
    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBe("writer");
    expect(res.body.data.status).toBe("EXECUTING");
  });

  it("GET /a2a/agents/:id/status reports unknown agents as IDLE/not-seen", async () => {
    const gw = makeGateway(makeHandler(), {
      getStatus: () => "IDLE",
      hasSeen: () => false,
    } as never);
    const res = await request(gw.app).get("/a2a/agents/ghost/status");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("IDLE");
    expect(res.body.data.seen).toBe(false);
  });

  it("GET /unknown-route returns 404", async () => {
    const res = await request(gateway.app).get("/unknown");
    expect(res.status).toBe(404);
    expect(res.body.errors[0].message).toBe("Not Found");
  });

  it("sets trust proxy when the option is true", () => {
    const gw = new GatewayApp({
      requestHandler: makeHandler(),
      statusTracker: makeTracker() as never,
      trustProxy: true,
    });
    expect(gw.app.get("trust proxy")).toBe(1);
  });

  it("does not set trust proxy by default", () => {
    expect(gateway.app.get("trust proxy")).toBeFalsy();
  });
});
