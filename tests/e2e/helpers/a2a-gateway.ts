/**
 * E2E helper: build a real GatewayApp backed by the official @a2a-js/sdk server
 * with an in-memory task store (no Redis needed for the auth / rate-limit suites).
 */
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { GatewayApp } from "../../../src/adapters/gateway/GatewayApp";
import { KaibanAgentExecutor } from "../../../src/infrastructure/federation/a2a-executor";
import { CompletionRouter } from "../../../src/shared/completion-router";
import { buildAgentCard } from "../../../src/infrastructure/federation/a2a-agent-card";
import type { IMessagingDriver } from "../../../src/infrastructure/messaging/interfaces";

function noopDriver(): IMessagingDriver {
  return {
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
  };
}

export interface E2EGatewayOptions {
  agentIds?: string[];
  jwtEnabled?: boolean;
  trustProxy?: boolean;
}

/** A valid JSON-RPC `message/send` request that resolves immediately. */
export function rpcSendBody(agentId = "researcher"): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "e2e-msg-1",
        parts: [{ kind: "text", text: "ping" }],
        metadata: { agentId },
      },
    },
  };
}

/** Build a GatewayApp around a real A2A SDK request handler. */
export function makeA2AGateway(opts: E2EGatewayOptions = {}): GatewayApp {
  const agentIds = opts.agentIds ?? ["researcher", "writer"];
  const card = buildAgentCard({
    name: "kaiban-e2e-worker",
    version: "2.0.0",
    baseUrl: "http://localhost:3000",
    agentIds,
    ...(opts.jwtEnabled !== undefined ? { jwtEnabled: opts.jwtEnabled } : {}),
  });
  const driver = noopDriver();
  const store = new InMemoryTaskStore();
  const executor = new KaibanAgentExecutor({
    driver,
    // With no worker, the wait resolves immediately so message/send completes.
    router: {
      wait: () => Promise.resolve("e2e-result"),
    } as unknown as CompletionRouter,
    taskStore: store,
    timeoutMs: 1000,
  });
  const requestHandler = new DefaultRequestHandler(card, store, executor);
  return new GatewayApp({
    requestHandler,
    statusTracker: {
      getStatus: () => "IDLE",
      hasSeen: () => false,
    } as never,
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
  });
}
