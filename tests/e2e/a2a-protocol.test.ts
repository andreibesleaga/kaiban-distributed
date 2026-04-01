/**
 * E2E: A2A Protocol HTTP Tests
 * Tests the Edge Gateway A2A endpoints over real HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { GatewayApp } from "../../src/adapters/gateway/GatewayApp";
import {
  A2AConnector,
  type AgentCard,
} from "../../src/infrastructure/federation/a2a-connector";

const agentCard: AgentCard = {
  name: "kaiban-e2e-worker",
  version: "1.0.0",
  description: "E2E test agent",
  capabilities: ["agent.status", "tasks.create", "tasks.get"],
  endpoints: { rpc: "/a2a/rpc" },
};

describe("E2E: A2A Protocol", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const connector = new A2AConnector(agentCard);
    const gateway = new GatewayApp(connector);
    server = createServer(gateway.app);

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve()); // port 0 = random available port
    });

    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /.well-known/agent-card.json returns 200 with valid AgentCard", async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentCard;
    expect(body.name).toBe("kaiban-e2e-worker");
    expect(body.capabilities).toContain("agent.status");
  });

  it("POST /a2a/rpc with agent.status returns JSON-RPC 2.0 response", async () => {
    const res = await fetch(`${baseUrl}/a2a/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.status" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: unknown;
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
  });

  it("POST /a2a/rpc with tasks.create returns a new task ID", async () => {
    const res = await fetch(`${baseUrl}/a2a/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks.create",
        params: {
          agentId: "kaiban-e2e-worker",
          instruction: "Analyze data",
          expectedOutput: "Summary",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { taskId: string } };
    expect(body.result.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("GET /health returns 200", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("ok");
  });
});
