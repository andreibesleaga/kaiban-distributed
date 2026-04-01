import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";

async function getA2AAuth(): Promise<
  typeof import("../../../src/infrastructure/security/a2a-auth")
> {
  return import("../../../src/infrastructure/security/a2a-auth");
}

describe("a2a-auth", () => {
  const SECRET = "test-a2a-secret-32bytes-padded!!!!";

  beforeEach(() => {
    process.env["A2A_JWT_SECRET"] = SECRET;
  });

  afterEach(() => {
    delete process.env["A2A_JWT_SECRET"];
  });

  // ─── issueA2AToken ────────────────────────────────────────────────────────

  it("issues a valid JWT string", async () => {
    const { issueA2AToken } = await getA2AAuth();
    const token = issueA2AToken("my-service");
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  it("embeds correct subject and role claims", async () => {
    const { issueA2AToken } = await getA2AAuth();
    const token = issueA2AToken("blog-team-orchestrator");
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded["sub"]).toBe("blog-team-orchestrator");
    expect(decoded["role"]).toBe("a2a-client");
  });

  it("respects custom expiry (default 86400 s)", async () => {
    const { issueA2AToken } = await getA2AAuth();
    const before = Math.floor(Date.now() / 1000);
    const token = issueA2AToken("svc", 3600);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    const exp = decoded["exp"] as number;
    expect(exp).toBeGreaterThanOrEqual(before + 3600 - 2);
    expect(exp).toBeLessThanOrEqual(before + 3600 + 2);
  });

  it("throws when A2A_JWT_SECRET is not set", async () => {
    delete process.env["A2A_JWT_SECRET"];
    const { issueA2AToken } = await getA2AAuth();
    expect(() => issueA2AToken("x")).toThrow("A2A_JWT_SECRET not set");
  });

  // ─── verifyA2AToken ───────────────────────────────────────────────────────

  it("verifies a token issued by issueA2AToken", async () => {
    const { issueA2AToken, verifyA2AToken } = await getA2AAuth();
    const token = issueA2AToken("worker-node-1");
    const payload = verifyA2AToken(`Bearer ${token}`);
    expect(payload["sub"]).toBe("worker-node-1");
    expect(payload["role"]).toBe("a2a-client");
  });

  it("throws on missing Authorization header (undefined)", async () => {
    const { verifyA2AToken } = await getA2AAuth();
    expect(() => verifyA2AToken(undefined)).toThrow(
      "Missing Authorization header",
    );
  });

  it("throws on Authorization header without Bearer prefix", async () => {
    const { verifyA2AToken } = await getA2AAuth();
    expect(() => verifyA2AToken("Token abc123")).toThrow(
      "Missing Authorization header",
    );
  });

  it("throws on expired token", async () => {
    const { verifyA2AToken } = await getA2AAuth();
    const expired = jwt.sign({ sub: "x", role: "a2a-client" }, SECRET, {
      algorithm: "HS256",
      expiresIn: -1,
    });
    expect(() => verifyA2AToken(`Bearer ${expired}`)).toThrow();
  });

  it("throws on token signed with wrong secret", async () => {
    const { verifyA2AToken } = await getA2AAuth();
    const bad = jwt.sign({ sub: "x", role: "a2a-client" }, "wrong-secret", {
      algorithm: "HS256",
      expiresIn: 3600,
    });
    expect(() => verifyA2AToken(`Bearer ${bad}`)).toThrow();
  });

  it("throws on malformed token in Bearer header", async () => {
    const { verifyA2AToken } = await getA2AAuth();
    expect(() => verifyA2AToken("Bearer not.a.valid.jwt")).toThrow();
  });

  it("throws when A2A_JWT_SECRET is not set during verify", async () => {
    const { issueA2AToken, verifyA2AToken } = await getA2AAuth();
    const token = issueA2AToken("svc");
    delete process.env["A2A_JWT_SECRET"];
    expect(() => verifyA2AToken(`Bearer ${token}`)).toThrow(
      "A2A_JWT_SECRET not set",
    );
  });
});
