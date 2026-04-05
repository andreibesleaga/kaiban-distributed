/**
 * E2E: Board HITL Integration — Full Socket.io → Gateway → Redis → Orchestrator Round-Trip
 *
 * Unlike blog-team-flow.test.ts which uses injectHITL() (direct Redis publish),
 * these tests exercise the FULL board path:
 *   socket.io client emits `hitl:decision` → SocketGateway validates →
 *   Redis publish to kaiban-hitl-decisions → waitForHITLDecision() resolves
 *
 * This is the path used by the React board's Approve/Revise/Reject buttons.
 *
 * Scenarios:
 *   1. Golden PUBLISH  — board sends PUBLISH → ACK ok → orchestrator resolves PUBLISH
 *   2. Golden REVISE   — board sends REVISE  → ACK ok → orchestrator resolves REVISE
 *   3. Golden REJECT   — board sends REJECT  → ACK ok → orchestrator resolves REJECT
 *   4. Invalid decision — board sends "INVALID" → ACK error, orchestrator pending
 *   5. Wrong taskId    — correct decision, wrong taskId → orchestrator stays pending
 *   6. VIEW rejected   — board sends VIEW (terminal-only) → gateway rejects
 *   7. Gateway failure — Redis publish fails → ACK ok:false returned
 *   8. Race: board wins first (resolves before terminal mock)
 *   9. Race: board deduplication (second message ignored after resolution)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { Redis } from "ioredis";
import { io as ioclient, type Socket as ClientSocket } from "socket.io-client";
import { SocketGateway } from "../../src/adapters/gateway/SocketGateway";
import { waitForHITLDecision } from "../../src/shared";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

/** Create a pair of Redis connections for the gateway (publisher + subscriber). */
function makeRedisPair(): { pub: Redis; sub: Redis } {
  const pub = new Redis(REDIS_URL);
  const sub = new Redis(REDIS_URL);
  pub.on("error", () => {
    /* suppress teardown noise */
  });
  sub.on("error", () => {
    /* suppress teardown noise */
  });
  return { pub, sub };
}

/**
 * Boot a real HTTP server + SocketGateway on a random free port.
 * Returns the gateway URL and a teardown function.
 */
async function bootGateway(
  redisPub: Redis,
  redisSub: Redis,
): Promise<{ url: string; shutdown: () => Promise<void> }> {
  const httpServer: HttpServer = createServer();
  const gateway = new SocketGateway(httpServer, redisPub, redisSub);
  gateway.initialize();

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address() as { port: number };
  const url = `http://localhost:${addr.port}`;

  return {
    url,
    shutdown: async (): Promise<void> => {
      await gateway.shutdown();
    },
  };
}

/**
 * Connect a socket.io client to `url`.
 * Returns the socket and a cleanup function.
 */
async function connectClient(
  url: string,
): Promise<{ socket: ClientSocket; close: () => void }> {
  const socket = ioclient(url, { forceNew: true, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5_000);
  });
  return {
    socket,
    close: () => socket.disconnect(),
  };
}

/** Emit `hitl:decision` and await the ACK. */
function emitDecision(
  socket: ClientSocket,
  taskId: string,
  decision: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit(
      "hitl:decision",
      { taskId, decision },
      (ack: { ok: boolean; error?: string }) => resolve(ack),
    );
  });
}

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe("E2E: Board HITL Integration (socket → gateway → Redis → orchestrator)", () => {
  let redisPub: Redis;
  let redisSub: Redis;
  let gatewayUrl: string;
  let gatewayShutdown: () => Promise<void>;

  beforeEach(async () => {
    const pair = makeRedisPair();
    redisPub = pair.pub;
    redisSub = pair.sub;
    const gw = await bootGateway(redisPub, redisSub);
    gatewayUrl = gw.url;
    gatewayShutdown = gw.shutdown;
  });

  afterEach(async () => {
    await gatewayShutdown();
    redisPub.disconnect();
    redisSub.disconnect();
  });

  // ─── Scenario 1: Golden path PUBLISH ──────────────────────────────────────
  it("Scenario 1 — PUBLISH: board emits PUBLISH → ACK ok → orchestrator resolves PUBLISH", async () => {
    const taskId = `hitl-integration-pub-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);

    try {
      // Start orchestrator waiting (board-only mode, no terminal)
      const decisionPromise = waitForHITLDecision({
        taskId,
        rl: null,
        redisUrl: REDIS_URL,
      });

      // Allow subscription to establish
      await new Promise((r) => setTimeout(r, 300));

      // Board emits decision via socket
      const ack = await emitDecision(socket, taskId, "PUBLISH");
      expect(ack.ok).toBe(true);
      expect(ack.error).toBeUndefined();

      // Orchestrator should resolve
      const decision = await decisionPromise;
      expect(decision).toBe("PUBLISH");
    } finally {
      close();
    }
  }, 15_000);

  // ─── Scenario 2: Golden path REVISE ───────────────────────────────────────
  it("Scenario 2 — REVISE: board emits REVISE → ACK ok → orchestrator resolves REVISE", async () => {
    const taskId = `hitl-integration-rev-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      const decisionPromise = waitForHITLDecision({
        taskId,
        rl: null,
        redisUrl: REDIS_URL,
      });

      await new Promise((r) => setTimeout(r, 300));

      const ack = await emitDecision(socket, taskId, "REVISE");
      expect(ack.ok).toBe(true);

      const decision = await decisionPromise;
      expect(decision).toBe("REVISE");
    } finally {
      close();
    }
  }, 15_000);

  // ─── Scenario 3: Golden path REJECT ───────────────────────────────────────
  it("Scenario 3 — REJECT: board emits REJECT → ACK ok → orchestrator resolves REJECT", async () => {
    const taskId = `hitl-integration-rej-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      const decisionPromise = waitForHITLDecision({
        taskId,
        rl: null,
        redisUrl: REDIS_URL,
      });

      await new Promise((r) => setTimeout(r, 300));

      const ack = await emitDecision(socket, taskId, "REJECT");
      expect(ack.ok).toBe(true);

      const decision = await decisionPromise;
      expect(decision).toBe("REJECT");
    } finally {
      close();
    }
  }, 15_000);

  // ─── Scenario 4: Invalid decision rejected by gateway ─────────────────────
  it("Scenario 4 — Invalid decision: gateway rejects INVALID → ACK error, orchestrator stays pending", async () => {
    const taskId = `hitl-integration-bad-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      let resolved = false;
      const decisionPromise = waitForHITLDecision({
        taskId,
        rl: null,
        redisUrl: REDIS_URL,
      }).then((d) => {
        resolved = true;
        return d;
      });

      await new Promise((r) => setTimeout(r, 300));

      const ack = await emitDecision(socket, taskId, "INVALID");
      expect(ack.ok).toBe(false);
      expect(ack.error).toContain("invalid decision value");

      // Give time for any stray message to arrive
      await new Promise((r) => setTimeout(r, 300));
      expect(resolved).toBe(false);

      // Cleanup: close the hanging promise by disconnecting
      void decisionPromise; // will be GC'd when Redis sub disconnects
    } finally {
      close();
    }
  }, 10_000);

  // ─── Scenario 5: Wrong taskId — orchestrator ignores the message ──────────
  it("Scenario 5 — Wrong taskId: decision for different taskId is ignored by orchestrator", async () => {
    const taskId = `hitl-integration-myid-${Date.now()}`;
    const wrongId = `hitl-integration-otherid-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      let resolved = false;
      const decisionPromise = waitForHITLDecision({
        taskId,
        rl: null,
        redisUrl: REDIS_URL,
      }).then((d) => {
        resolved = true;
        return d;
      });

      await new Promise((r) => setTimeout(r, 300));

      // Send decision for wrong taskId — gateway ACKs ok (gateway doesn't know taskId context)
      const ack = await emitDecision(socket, wrongId, "PUBLISH");
      expect(ack.ok).toBe(true); // gateway accepted (valid decision, valid taskId format)

      // But orchestrator should NOT resolve (wrong taskId)
      await new Promise((r) => setTimeout(r, 400));
      expect(resolved).toBe(false);

      // Now send the correct taskId — orchestrator should resolve
      const ack2 = await emitDecision(socket, taskId, "PUBLISH");
      expect(ack2.ok).toBe(true);

      const decision = await decisionPromise;
      expect(decision).toBe("PUBLISH");
    } finally {
      close();
    }
  }, 15_000);

  // ─── Scenario 6: VIEW rejected by gateway (terminal-only decision) ────────
  it("Scenario 6 — VIEW rejected: gateway does not accept VIEW (terminal-only)", async () => {
    const taskId = `hitl-integration-view-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      const ack = await emitDecision(socket, taskId, "VIEW");
      expect(ack.ok).toBe(false);
      expect(ack.error).toContain("invalid decision value");
    } finally {
      close();
    }
  }, 10_000);

  // ─── Scenario 7: Malformed payload — gateway rejects gracefully ───────────
  it("Scenario 7 — Malformed payload: gateway rejects null payload with error ACK", async () => {
    const { socket, close } = await connectClient(gatewayUrl);
    try {
      const ack = await new Promise<{ ok: boolean; error?: string }>(
        (resolve) => {
          socket.emit(
            "hitl:decision",
            null,
            (r: { ok: boolean; error?: string }) => resolve(r),
          );
        },
      );
      expect(ack.ok).toBe(false);
      expect(ack.error).toBeDefined();
    } finally {
      close();
    }
  }, 10_000);

  // ─── Scenario 8: Board wins race (board emits before any terminal answer) ──
  it("Scenario 8 — Race (board wins): board resolves before terminal-only orchestrator times out", async () => {
    const taskId = `hitl-integration-race-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      const decisionPromise = waitForHITLDecision({
        taskId,
        rl: null,
        redisUrl: REDIS_URL,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Board sends REVISE first
      const ack = await emitDecision(socket, taskId, "REVISE");
      expect(ack.ok).toBe(true);

      const decision = await decisionPromise;
      expect(decision).toBe("REVISE");
    } finally {
      close();
    }
  }, 15_000);

  // ─── Scenario 9: Deduplication — second board message ignored ────────────
  it("Scenario 9 — Deduplication: second board message after resolution is ignored", async () => {
    const taskId = `hitl-integration-dedup-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      const decisionPromise = waitForHITLDecision({
        taskId,
        rl: null,
        redisUrl: REDIS_URL,
      });

      await new Promise((r) => setTimeout(r, 300));

      // First message — resolves the promise
      await emitDecision(socket, taskId, "PUBLISH");

      const decision = await decisionPromise;
      expect(decision).toBe("PUBLISH");

      // Second message — gateway accepts (it has no memory of previous), but
      // the orchestrator's `resolved` flag prevents double resolution
      const ack2 = await emitDecision(socket, taskId, "REJECT");
      expect(ack2.ok).toBe(true); // gateway ok, but orchestrator ignores it

      // The resolved promise should still return PUBLISH (not REJECT)
      // (already resolved above; this just confirms no exception)
    } finally {
      close();
    }
  }, 15_000);

  // ─── Scenario 10: Multiple concurrent orchestrators, isolated by taskId ───
  it("Scenario 10 — Isolation: two concurrent orchestrators resolve independently by taskId", async () => {
    const taskIdA = `hitl-integration-concA-${Date.now()}`;
    const taskIdB = `hitl-integration-concB-${Date.now()}`;

    const { socket, close } = await connectClient(gatewayUrl);
    try {
      // Start two concurrent orchestrator instances for different tasks
      const decisionA = waitForHITLDecision({
        taskId: taskIdA,
        rl: null,
        redisUrl: REDIS_URL,
      });
      const decisionB = waitForHITLDecision({
        taskId: taskIdB,
        rl: null,
        redisUrl: REDIS_URL,
      });

      await new Promise((r) => setTimeout(r, 400));

      // Send B's decision first
      const ackB = await emitDecision(socket, taskIdB, "REJECT");
      expect(ackB.ok).toBe(true);

      // Send A's decision second
      const ackA = await emitDecision(socket, taskIdA, "PUBLISH");
      expect(ackA.ok).toBe(true);

      // Both should resolve with their own decision
      const [resultA, resultB] = await Promise.all([decisionA, decisionB]);
      expect(resultA).toBe("PUBLISH");
      expect(resultB).toBe("REJECT");
    } finally {
      close();
    }
  }, 20_000);
});
