/**
 * E2E / Conformance: the OFFICIAL @a2a-js/sdk CLIENT against our SDK-backed
 * server (mounted in GatewayApp). Exercises the real v0.3 wire: AgentCard,
 * message/send, message/stream, tasks/get, tasks/cancel — no custom client.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { A2AClient } from "@a2a-js/sdk/client";
import type { Message, Task } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { GatewayApp } from "../../src/adapters/gateway/GatewayApp";
import { KaibanAgentExecutor } from "../../src/infrastructure/federation/a2a-executor";
import { buildAgentCard } from "../../src/infrastructure/federation/a2a-agent-card";
import type { CompletionRouter } from "../../src/shared/completion-router";

/** A router whose wait() can be resolved/aborted on demand per taskId. */
function controllableRouter(): {
  router: Pick<CompletionRouter, "wait">;
  resolveAll: (value: string) => void;
} {
  const resolvers: Array<(v: string) => void> = [];
  return {
    router: {
      wait: (_id, _ms, _label, signal) =>
        new Promise<string>((resolve, reject) => {
          resolvers.push(resolve);
          signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    } as Pick<CompletionRouter, "wait">,
    resolveAll: (value: string) => resolvers.forEach((r) => r(value)),
  };
}

function userMessage(text: string, agentId = "writer"): Message {
  return {
    kind: "message",
    role: "user",
    messageId: `c-${Math.random().toString(36).slice(2)}`,
    parts: [{ kind: "text", text }],
    metadata: { agentId },
  };
}

describe("A2A conformance — official @a2a-js/sdk client ↔ our server", () => {
  let server: Server;
  let baseUrl: string;
  let client: A2AClient;
  let ctl: ReturnType<typeof controllableRouter>;

  beforeAll(async () => {
    const card = buildAgentCard({
      name: "kaiban-conformance",
      version: "2.0.0",
      baseUrl: "http://PLACEHOLDER",
      agentIds: ["writer"],
    });
    const store = new InMemoryTaskStore();
    ctl = controllableRouter();
    const executor = new KaibanAgentExecutor({
      driver: { publish: (): Promise<void> => Promise.resolve() },
      router: ctl.router as CompletionRouter,
      taskStore: store,
      timeoutMs: 5000,
    });
    const requestHandler = new DefaultRequestHandler(card, store, executor);
    const gateway = new GatewayApp({
      requestHandler,
      statusTracker: { getStatus: () => "IDLE", hasSeen: () => false } as never,
    });
    server = createServer(gateway.app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const { port } = server.address() as { port: number };
    baseUrl = `http://localhost:${port}`;
    // Rebuild the card URL so the client resolves the right endpoint.
    card.url = `${baseUrl}/a2a/rpc`;
    client = await A2AClient.fromCardUrl(
      `${baseUrl}/.well-known/agent-card.json`,
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it("serves a v0.3 AgentCard the SDK client can resolve", async () => {
    const card = await client.getAgentCard();
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.name).toBe("kaiban-conformance");
    expect(card.skills.map((s) => s.id)).toContain("writer");
  });

  it("message/send (non-blocking) returns a Task the client can read", async () => {
    const res = await client.sendMessage({
      message: userMessage("draft something"),
      configuration: { blocking: false },
    });
    expect("result" in res).toBe(true);
    if ("result" in res) {
      const task = res.result as Task;
      expect(task.kind).toBe("task");
      expect(["submitted", "working"]).toContain(task.status.state);
    }
  });

  it("tasks/get returns the persisted, in-progress task", async () => {
    const sent = await client.sendMessage({
      message: userMessage("long job"),
      configuration: { blocking: false },
    });
    if (!("result" in sent)) throw new Error("expected a Task");
    const taskId = (sent.result as Task).id;
    const got = await client.getTask({ id: taskId });
    expect("result" in got).toBe(true);
    if ("result" in got) {
      expect((got.result as Task).id).toBe(taskId);
    }
  });

  it("tasks/cancel transitions the task to canceled", async () => {
    const sent = await client.sendMessage({
      message: userMessage("cancel me"),
      configuration: { blocking: false },
    });
    if (!("result" in sent)) throw new Error("expected a Task");
    const taskId = (sent.result as Task).id;
    const canceled = await client.cancelTask({ id: taskId });
    expect("result" in canceled).toBe(true);
    if ("result" in canceled) {
      expect((canceled.result as Task).status.state).toBe("canceled");
    }
  });

  it("message/stream yields status updates ending in a final completed event", async () => {
    const stream = client.sendMessageStream({
      message: userMessage("stream please"),
    });
    const states: string[] = [];
    // Resolve the underlying work shortly after the stream starts.
    setTimeout(() => ctl.resolveAll("STREAMED RESULT"), 50);
    for await (const event of stream) {
      if (event.kind === "status-update") {
        states.push(event.status.state);
        if (event.final) break;
      }
    }
    expect(states).toContain("working");
    expect(states.at(-1)).toBe("completed");
  });
});
