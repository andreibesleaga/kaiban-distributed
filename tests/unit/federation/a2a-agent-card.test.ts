import { describe, it, expect } from "vitest";
import {
  buildAgentCard,
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
} from "../../../src/infrastructure/federation/a2a-agent-card";

describe("buildAgentCard (v0.3)", () => {
  const base = {
    name: "kaiban-worker",
    version: "2.0.0",
    baseUrl: "https://kaiban.example.com",
    agentIds: ["researcher", "writer"],
  };

  it("emits the v0.3 protocol version and well-known path constant", () => {
    expect(A2A_PROTOCOL_VERSION).toBe("0.3.0");
    expect(AGENT_CARD_PATH).toBe(".well-known/agent-card.json");
  });

  it("builds a card with all required v0.3 fields", () => {
    const card = buildAgentCard(base);
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.name).toBe("kaiban-worker");
    expect(card.version).toBe("2.0.0");
    expect(card.url).toBe("https://kaiban.example.com/a2a/rpc");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.defaultOutputModes).toContain("text/plain");
    expect(Array.isArray(card.skills)).toBe(true);
  });

  it("declares one skill per advertised agentId", () => {
    const card = buildAgentCard(base);
    expect(card.skills).toHaveLength(2);
    expect(card.skills.map((s) => s.id)).toEqual(["researcher", "writer"]);
    for (const skill of card.skills) {
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(Array.isArray(skill.tags)).toBe(true);
    }
  });

  it("advertises JSONRPC + HTTP+JSON + GRPC interfaces", () => {
    const card = buildAgentCard(base);
    const transports = (card.additionalInterfaces ?? []).map((i) => i.transport);
    expect(transports).toContain("JSONRPC");
    expect(transports).toContain("HTTP+JSON");
    expect(transports).toContain("GRPC");
  });

  it("capabilities: streaming on; push-notifications off by default", () => {
    const card = buildAgentCard(base);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it("enables the pushNotifications capability flag when requested", () => {
    const card = buildAgentCard({ ...base, pushNotifications: true });
    expect(card.capabilities.pushNotifications).toBe(true);
  });

  it("omits securitySchemes when JWT is disabled", () => {
    const card = buildAgentCard(base);
    expect(card.securitySchemes).toBeUndefined();
    expect(card.security).toBeUndefined();
  });

  it("maps JWT → HTTPAuthSecurityScheme (Bearer/JWT) when enabled", () => {
    const card = buildAgentCard({ ...base, jwtEnabled: true });
    expect(card.securitySchemes).toBeDefined();
    const scheme = card.securitySchemes?.["bearerAuth"];
    expect(scheme).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: expect.any(String),
    });
    expect(card.security).toEqual([{ bearerAuth: [] }]);
  });

  it("includes a provider when an organization is supplied", () => {
    const card = buildAgentCard({
      ...base,
      provider: { organization: "Kaiban", url: "https://kaiban.example.com" },
    });
    expect(card.provider).toEqual({
      organization: "Kaiban",
      url: "https://kaiban.example.com",
    });
  });

  it("trims a trailing slash from baseUrl when composing the rpc url", () => {
    const card = buildAgentCard({ ...base, baseUrl: "https://x.io/" });
    expect(card.url).toBe("https://x.io/a2a/rpc");
  });

  it("falls back to a generic skill when no agentIds are given", () => {
    const card = buildAgentCard({ ...base, agentIds: [] });
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]?.id).toBe("execute-task");
  });
});
