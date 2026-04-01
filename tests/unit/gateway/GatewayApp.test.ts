import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { GatewayApp } from "../../../src/adapters/gateway/GatewayApp";
import {
  A2AConnector,
  type AgentCard,
} from "../../../src/infrastructure/federation/a2a-connector";
import type { DomainError } from "../../../src/domain/errors/DomainError";

const testCard: AgentCard = {
  name: "kaiban-worker",
  version: "1.0.0",
  description: "Test",
  capabilities: ["agent.status"],
  endpoints: { rpc: "/a2a/rpc" },
};

describe("GatewayApp", () => {
  let gateway: GatewayApp;
  beforeEach(() => {
    gateway = new GatewayApp(new A2AConnector(testCard));
  });

  it("GET /health returns 200", async () => {
    const res = await request(gateway.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
  });

  it("GET /.well-known/agent-card.json returns agent card", async () => {
    const res = await request(gateway.app).get("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("kaiban-worker");
  });

  it("POST /a2a/rpc with valid JSON-RPC returns 200", async () => {
    const res = await request(gateway.app)
      .post("/a2a/rpc")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 1, method: "agent.status" });
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe("2.0");
  });

  it("POST /a2a/rpc with text/plain returns 415", async () => {
    const res = await request(gateway.app)
      .post("/a2a/rpc")
      .set("Content-Type", "text/plain")
      .send("data");
    expect(res.status).toBe(415);
  });

  it("POST /a2a/rpc with no body/header returns 415 (covers ?? null branch)", async () => {
    // No Content-Type set at all → req.headers['content-type'] is undefined → ?? ''
    const res = await request(gateway.app).post("/a2a/rpc");
    expect(res.status).toBe(415);
  });

  it("GET /unknown-route returns 404", async () => {
    const res = await request(gateway.app).get("/unknown");
    expect(res.status).toBe(404);
    expect(res.body.errors[0].message).toBe("Not Found");
  });

  it("POST /a2a/rpc connector error returns 500", async () => {
    const errorConnector = new A2AConnector(testCard);
    vi.spyOn(errorConnector, "handleRpc").mockResolvedValueOnce({
      ok: false,
      error: {
        code: "ERR",
        message: "fail",
        name: "Error",
      } as unknown as DomainError,
    });
    const gw = new GatewayApp(errorConnector);
    const res = await request(gw.app)
      .post("/a2a/rpc")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 9, method: "agent.status" });
    expect(res.status).toBe(500);
  });
});
