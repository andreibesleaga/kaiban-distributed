import { vi } from "vitest";
import {
  GatewayApp,
  type GatewayAppDeps,
} from "../../../src/adapters/gateway/GatewayApp";
import type { A2ARequestHandler } from "@a2a-js/sdk/server";
import type { AgentCard, Task } from "@a2a-js/sdk";
import { buildAgentCard } from "../../../src/infrastructure/federation/a2a-agent-card";

/** A v0.3 AgentCard used across the gateway tests. */
export const testCard: AgentCard = buildAgentCard({
  name: "kaiban-worker",
  version: "2.0.0",
  baseUrl: "http://localhost:3000",
  agentIds: ["writer"],
});

const completedTask: Task = {
  kind: "task",
  id: "t-1",
  contextId: "c-1",
  status: { state: "completed" },
};

/** A minimal stub of the SDK A2A request handler. */
export function makeRequestHandler(
  overrides: Partial<A2ARequestHandler> = {},
): A2ARequestHandler {
  return {
    getAgentCard: vi.fn().mockResolvedValue(testCard),
    sendMessage: vi.fn().mockResolvedValue(completedTask),
    sendMessageStream: vi.fn(),
    getTask: vi.fn().mockResolvedValue(completedTask),
    cancelTask: vi
      .fn()
      .mockResolvedValue({ ...completedTask, status: { state: "canceled" } }),
    ...overrides,
  } as unknown as A2ARequestHandler;
}

/** A stub status tracker that always reports the given status. */
export function makeStatusTracker(
  status: "IDLE" | "THINKING" | "EXECUTING" | "ERROR" = "IDLE",
  seen = true,
): { getStatus: () => string; hasSeen: () => boolean } {
  return { getStatus: () => status, hasSeen: () => seen };
}

/** Build a GatewayApp with sensible test defaults. */
export function makeGateway(
  overrides: Partial<GatewayAppDeps> = {},
): GatewayApp {
  return new GatewayApp({
    requestHandler: overrides.requestHandler ?? makeRequestHandler(),
    statusTracker: (overrides.statusTracker ?? makeStatusTracker()) as never,
    ...(overrides.trustProxy !== undefined
      ? { trustProxy: overrides.trustProxy }
      : {}),
  });
}

/** A valid JSON-RPC `message/send` body for exercising the RPC route. */
export const RPC_SEND = {
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
} as const;
