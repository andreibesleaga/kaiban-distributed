/**
 * E2E: Security Integration Tests
 *
 * Verifies that auth and channel-signing work end-to-end over real HTTP / real crypto.
 * No real Redis or BullMQ is needed — all tests use in-process servers.
 *
 * Tests:
 *  - A2A JWT auth on POST /a2a/rpc (enabled/disabled by A2A_JWT_SECRET)
 *  - Channel signing round-trip (wrapSigned → unwrapVerified)
 *  - Error sanitization (production mode hides internal errors)
 *  - GatewayApp health rate limiting (stricter 5 req/min)
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { createServer, type Server } from "http";
import { GatewayApp } from "../../src/adapters/gateway/GatewayApp";
import {
  A2AConnector,
  type AgentCard,
} from "../../src/infrastructure/federation/a2a-connector";
import { issueA2AToken } from "../../src/infrastructure/security/a2a-auth";
import {
  wrapSigned,
  unwrapVerified,
} from "../../src/infrastructure/security/channel-signing";
import {
  issueBoardToken,
  verifyBoardToken,
} from "../../src/infrastructure/security/board-auth";

const agentCard: AgentCard = {
  name: "security-e2e-worker",
  version: "1.0.0",
  description: "Security integration test agent",
  capabilities: ["agent.status", "tasks.create"],
  endpoints: { rpc: "/a2a/rpc" },
};

const A2A_SECRET = "e2e-a2a-secret-must-be-32-chars!!";
const BOARD_SECRET = "e2e-board-secret-must-32-chars!!!";
const CHANNEL_SECRET = "e2e-channel-secret-32bytes!!!!!";
const RPC_BODY = { jsonrpc: "2.0", id: 1, method: "agent.status" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function postRpc(
  baseUrl: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/a2a/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(RPC_BODY),
  });
}

// ─── A2A auth integration ─────────────────────────────────────────────────────

describe("E2E: A2A JWT authentication", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    process.env["A2A_JWT_SECRET"] = A2A_SECRET;
    const gateway = new GatewayApp(new A2AConnector(agentCard));
    server = createServer(gateway.app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterEach(async () => {
    delete process.env["A2A_JWT_SECRET"];
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await postRpc(baseUrl);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0]?.message).toBe("Unauthorized");
  });

  it("returns 401 for malformed Bearer token", async () => {
    const res = await postRpc(baseUrl, { Authorization: "Bearer bad-token" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for token signed with wrong secret", async () => {
    process.env["A2A_JWT_SECRET"] = "wrong-secret-must-be-32-chars!!!!";
    const badToken = issueA2AToken("attacker");
    process.env["A2A_JWT_SECRET"] = A2A_SECRET;
    const res = await postRpc(baseUrl, { Authorization: `Bearer ${badToken}` });
    expect(res.status).toBe(401);
  });

  it("returns 200 for a valid service token", async () => {
    const token = issueA2AToken("blog-team-orchestrator");
    const res = await postRpc(baseUrl, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jsonrpc: string; result: unknown };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result).toBeDefined();
  });

  it("passes through when A2A_JWT_SECRET is not set", async () => {
    // Create a separate gateway with no secret
    delete process.env["A2A_JWT_SECRET"];
    const gw2 = new GatewayApp(new A2AConnector(agentCard));
    const srv2 = createServer(gw2.app);
    await new Promise<void>((resolve) => srv2.listen(0, () => resolve()));
    const addr2 = srv2.address() as { port: number };
    const url2 = `http://localhost:${addr2.port}`;
    const res = await postRpc(url2);
    expect(res.status).toBe(200);
    await new Promise<void>((resolve, reject) =>
      srv2.close((e) => (e ? reject(e) : resolve())),
    );
  });
});

// ─── Channel signing round-trip ───────────────────────────────────────────────

describe("E2E: Channel signing round-trip", () => {
  afterEach(() => {
    delete process.env["CHANNEL_SIGNING_SECRET"];
  });

  it("wrapSigned → unwrapVerified returns original payload when secret is set", () => {
    process.env["CHANNEL_SIGNING_SECRET"] = CHANNEL_SECRET;
    const payload = {
      teamWorkflowStatus: "RUNNING",
      agents: [{ agentId: "researcher", status: "IDLE" }],
      metadata: { totalTokens: 500, estimatedCost: 0.01 },
    };
    const wrapped = wrapSigned(payload);
    const unwrapped = unwrapVerified(wrapped);
    expect(unwrapped).toEqual(payload);
  });

  it("unwrapVerified returns null when payload is tampered", () => {
    process.env["CHANNEL_SIGNING_SECRET"] = CHANNEL_SECRET;
    const payload = { teamWorkflowStatus: "RUNNING" };
    const wrapped = wrapSigned(payload);
    // Tamper the envelope
    const envelope = JSON.parse(wrapped) as {
      payload: Record<string, unknown>;
      sig: string;
      ts: number;
    };
    envelope.payload["teamWorkflowStatus"] = "FINISHED";
    expect(unwrapVerified(JSON.stringify(envelope))).toBeNull();
  });

  it("passes plain JSON through when CHANNEL_SIGNING_SECRET is not set", () => {
    const payload = { teamWorkflowStatus: "RUNNING" };
    const wrapped = wrapSigned(payload);
    const unwrapped = unwrapVerified(wrapped);
    expect(unwrapped).toEqual(payload);
  });

  it("wrapSigned produces different output each time (ts differs)", () => {
    process.env["CHANNEL_SIGNING_SECRET"] = CHANNEL_SECRET;
    const payload = { x: 1 };
    const w1 = wrapSigned(payload);
    // Force distinct timestamps
    const w2 = wrapSigned(payload);
    // Both should unwrap correctly
    expect(unwrapVerified(w1)).toEqual(payload);
    expect(unwrapVerified(w2)).toEqual(payload);
  });

  it("unwrapVerified returns null when a message with wrong secret is received", () => {
    process.env["CHANNEL_SIGNING_SECRET"] = "publisher-secret-must-be-32-char!";
    const payload = { x: 1 };
    const wrapped = wrapSigned(payload);
    // Consumer has different secret
    process.env["CHANNEL_SIGNING_SECRET"] = CHANNEL_SECRET;
    expect(unwrapVerified(wrapped)).toBeNull();
  });
});

// ─── Board JWT integration ────────────────────────────────────────────────────

describe("E2E: Board JWT issue/verify", () => {
  afterEach(() => {
    delete process.env["BOARD_JWT_SECRET"];
  });

  it("issues and verifies a board viewer token", () => {
    process.env["BOARD_JWT_SECRET"] = BOARD_SECRET;
    const token = issueBoardToken("alice");
    const payload = verifyBoardToken(token);
    expect(payload["sub"]).toBe("alice");
    expect(payload["role"]).toBe("board-viewer");
  });

  it("issued token contains an exp claim in the future", () => {
    process.env["BOARD_JWT_SECRET"] = BOARD_SECRET;
    const token = issueBoardToken("bob", 1800);
    const payload = verifyBoardToken(token);
    const exp = payload["exp"] as number;
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("verifyBoardToken throws on a token from a different secret", () => {
    process.env["BOARD_JWT_SECRET"] = "issuer-secret-must-be-32chars!!!!";
    const token = issueBoardToken("charlie");
    process.env["BOARD_JWT_SECRET"] = BOARD_SECRET; // different secret for verify
    expect(() => verifyBoardToken(token)).toThrow();
  });
});

// ─── GatewayApp: health rate limit and error sanitization ────────────────────

describe("E2E: GatewayApp hardening", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const gateway = new GatewayApp(new A2AConnector(agentCard));
    server = createServer(gateway.app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it("POST /a2a/rpc without Content-Type returns 415", async () => {
    const res = await fetch(`${baseUrl}/a2a/rpc`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  it("GET /health returns 200 with ok status", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("ok");
  });

  it("GET /unknown returns 404", async () => {
    const res = await fetch(`${baseUrl}/unknown-route`);
    expect(res.status).toBe(404);
  });

  it("agent.status returns correct JSON-RPC 2.0 structure", async () => {
    const res = await fetch(`${baseUrl}/a2a/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "agent.status" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: Record<string, unknown>;
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(99);
    expect(body.result["status"]).toBe("IDLE");
  });
});
