import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { makeGateway, RPC_SEND } from "./gateway-test-helpers";

const A2A_SECRET = "test-a2a-secret-for-gateway-auth!!";

function makeToken(secret = A2A_SECRET, expiresIn = 3600): string {
  return jwt.sign({ sub: "test-svc", role: "a2a-client" }, secret, {
    algorithm: "HS256",
    expiresIn,
  });
}

describe("GatewayApp — A2A auth middleware", () => {
  afterEach(() => {
    delete process.env["A2A_JWT_SECRET"];
    delete process.env["NODE_ENV"];
    delete process.env["TRUST_PROXY"];
  });

  // ─── Auth disabled (no A2A_JWT_SECRET) ────────────────────────────────────

  it("allows any request when A2A_JWT_SECRET is not set", async () => {
    const gw = makeGateway();
    const res = await request(gw.app)
      .post("/a2a/rpc")
      .set("Content-Type", "application/json")
      .send(RPC_SEND);
    expect(res.status).toBe(200);
  });

  // ─── Auth enabled (A2A_JWT_SECRET set) ────────────────────────────────────

  describe("with A2A_JWT_SECRET set", () => {
    beforeEach(() => {
      process.env["A2A_JWT_SECRET"] = A2A_SECRET;
    });

    it("returns 401 when Authorization header is missing", async () => {
      const gw = makeGateway();
      const res = await request(gw.app)
        .post("/a2a/rpc")
        .set("Content-Type", "application/json")
        .send(RPC_SEND);
      expect(res.status).toBe(401);
      expect(res.body.errors[0].message).toBe("Unauthorized");
    });

    it("returns 401 when token is signed with wrong secret", async () => {
      const gw = makeGateway();
      const bad = makeToken("wrong-secret");
      const res = await request(gw.app)
        .post("/a2a/rpc")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${bad}`)
        .send(RPC_SEND);
      expect(res.status).toBe(401);
    });

    it("returns 401 when token is expired", async () => {
      const gw = makeGateway();
      const expired = makeToken(A2A_SECRET, -1);
      const res = await request(gw.app)
        .post("/a2a/rpc")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${expired}`)
        .send(RPC_SEND);
      expect(res.status).toBe(401);
    });

    it("returns 401 for malformed Bearer token", async () => {
      const gw = makeGateway();
      const res = await request(gw.app)
        .post("/a2a/rpc")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer not.a.jwt")
        .send(RPC_SEND);
      expect(res.status).toBe(401);
    });

    it("returns 200 with valid Bearer token", async () => {
      const gw = makeGateway();
      const token = makeToken();
      const res = await request(gw.app)
        .post("/a2a/rpc")
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${token}`)
        .send(RPC_SEND);
      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe("2.0");
    });
  });

  // ─── Health endpoint rate limiting ────────────────────────────────────────

  it("health endpoint enforces a separate (stricter) rate limit", async () => {
    const gw = makeGateway();
    // First 5 requests succeed
    for (let i = 0; i < 5; i++) {
      const res = await request(gw.app).get("/health");
      expect(res.status).toBe(200);
    }
    // 6th request is rate-limited (health limiter = 5 req/min)
    const res6 = await request(gw.app).get("/health");
    expect(res6.status).toBe(429);
  });

  // ─── Trust proxy ──────────────────────────────────────────────────────────

  it("sets trust proxy when trustProxy option is true", () => {
    const gw = makeGateway({ trustProxy: true });
    // Express stores trust proxy as 1 when enabled
    expect(gw.app.get("trust proxy")).toBe(1);
  });

  it("does not set trust proxy when trustProxy option is omitted", () => {
    const gw = makeGateway();
    expect(gw.app.get("trust proxy")).toBeFalsy();
  });
});
