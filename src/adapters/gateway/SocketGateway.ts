// SPDX-License-Identifier: Apache-2.0
import { Server as HttpServer } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type Redis from "ioredis";
import {
  STATE_CHANNEL,
  STATE_EVENT_UPDATE,
  STATE_EVENT_REQUEST,
  HITL_CHANNEL,
  HITL_SOCKET_EVENT,
  CONTROL_STOP_ALL_EVENT,
} from "../../infrastructure/messaging/channels";
import type { EmergencyStopIngress } from "./emergency-stop-ingress";
import { verifyBoardToken } from "../../infrastructure/security/board-auth";
import {
  unwrapVerified,
  wrapSigned,
} from "../../infrastructure/security/channel-signing";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "SocketGateway" });

const STATE_EVENT = STATE_EVENT_UPDATE;
const DEFAULT_DECISIONS = ["PUBLISH", "REVISE", "REJECT"];
/** Task ids are UUIDs or simple slugs; anything else never reaches a Redis key. */
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
/** HITL decisions accepted per connection per window. */
const HITL_MAX_PER_WINDOW = 10;
const HITL_WINDOW_MS = 10_000;

type HitlAck = (response: { ok: boolean; error?: string }) => void;
type StopAllAck = (response: Record<string, unknown>) => void;

/** The latest emergency stop as boards see it (ADR-025). */
interface LastStop {
  commandId: string;
  issuedAt: number;
  issuedBy: string;
  reason?: string;
}

/** The latest stop described by a `control` delta, or null when it is malformed. */
function stopOfAck(ack: unknown): LastStop | null {
  if (ack === null || typeof ack !== "object") return null;
  const a = ack as Record<string, unknown>;
  if (typeof a["commandId"] !== "string" || typeof a["issuedAt"] !== "number") {
    return null;
  }
  return {
    commandId: a["commandId"],
    issuedAt: a["issuedAt"],
    issuedBy: typeof a["issuedBy"] === "string" ? a["issuedBy"] : "unknown",
    ...(typeof a["reason"] === "string" ? { reason: a["reason"] } : {}),
  };
}

/** Why a HITL payload is refused, or null when it is well-formed. */
function hitlPayloadError(
  payload: unknown,
  validDecisions: string[],
): string | null {
  if (typeof payload !== "object" || payload === null) return "invalid payload";
  const { taskId, decision } = payload as Record<string, unknown>;
  if (typeof taskId !== "string" || typeof decision !== "string") {
    return "invalid taskId or decision";
  }
  if (!TASK_ID_PATTERN.test(taskId)) return "invalid taskId";
  if (!validDecisions.includes(decision)) {
    return `invalid decision value: ${decision}`;
  }
  return null;
}

/**
 * Accumulated state snapshot.
 * Merged from every delta received on kaiban-state-events since gateway start.
 * Sent to each newly connected / reconnected board client so it sees the full
 * current picture immediately — not just future incremental deltas.
 */
interface StateSnapshot {
  teamWorkflowStatus?: string;
  agents: Map<string, Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  /** Present only with the control plane on: the latest stop + node acks for it. */
  controlPlane?: { enabled: true; lastStop?: LastStop; acks: number };
}

export class SocketGateway {
  private io: SocketIOServer | null = null;
  private httpServer: HttpServer;
  private redisPublisher: Redis;
  private redisSubscriber: Redis;
  /** Dedicated publisher for HITL decisions — separate from the Socket.IO adapter's pubClient */
  private hitlPublisher: Redis;
  private validDecisions: string[];
  /** Emergency STOP ALL ingress; set only with CONTROL_PLANE_ENABLED (ADR-025). */
  private control?: EmergencyStopIngress;

  /** Running state snapshot — gate truth for reconnecting clients */
  private snapshot: StateSnapshot = { agents: new Map(), tasks: new Map() };

  constructor(
    httpServer: HttpServer,
    redisPublisher: Redis,
    redisSubscriber: Redis,
    opts?: {
      validHitlDecisions?: string[];
      hitlPublisher?: Redis;
      control?: EmergencyStopIngress;
    },
  ) {
    this.httpServer = httpServer;
    this.redisPublisher = redisPublisher;
    this.redisSubscriber = redisSubscriber;
    this.hitlPublisher = opts?.hitlPublisher ?? redisPublisher;
    this.validDecisions = opts?.validHitlDecisions ?? DEFAULT_DECISIONS;
    this.control = opts?.control;
    if (this.control) this.snapshot.controlPlane = { enabled: true, acks: 0 };
  }

  // ─── Snapshot helpers ────────────────────────────────────────────────────

  private applyStatusUpdate(delta: Record<string, unknown>): void {
    const newStatus =
      typeof delta["teamWorkflowStatus"] === "string"
        ? delta["teamWorkflowStatus"]
        : undefined;
    if (newStatus === undefined) return;
    // When a workflow restarts from a terminal state, clear stale tasks
    const prev = this.snapshot.teamWorkflowStatus;
    if (
      newStatus === "RUNNING" &&
      (prev === "FINISHED" || prev === "STOPPED" || prev === "ERRORED")
    ) {
      this.snapshot.tasks.clear();
    }
    this.snapshot.teamWorkflowStatus = newStatus;
  }

  private applyMapDelta(
    delta: Record<string, unknown>,
    field: string,
    idKey: string,
    map: Map<string, Record<string, unknown>>,
  ): void {
    if (!Array.isArray(delta[field])) return;
    for (const item of delta[field] as Record<string, unknown>[]) {
      const id = item[idKey];
      if (typeof id === "string") {
        map.set(id, { ...(map.get(id) ?? {}), ...item });
      }
    }
  }

  /** A `control` delta: a newer stop replaces the last one; node acks are counted. */
  private applyControl(delta: Record<string, unknown>): void {
    const plane = this.snapshot.controlPlane;
    const stop = plane ? stopOfAck(delta["control"]) : null;
    if (!plane || !stop) return;
    if (!plane.lastStop || stop.issuedAt > plane.lastStop.issuedAt) {
      plane.lastStop = stop;
      plane.acks = 0;
    }
    const outcome = (delta["control"] as Record<string, unknown>)["outcome"];
    if (stop.commandId === plane.lastStop.commandId && outcome !== "issued") {
      plane.acks++;
    }
  }

  private applyToSnapshot(delta: Record<string, unknown>): void {
    this.applyStatusUpdate(delta);
    this.applyControl(delta);
    this.applyMapDelta(delta, "agents", "agentId", this.snapshot.agents);
    this.applyMapDelta(delta, "tasks", "taskId", this.snapshot.tasks);
    if (delta["metadata"] !== null && typeof delta["metadata"] === "object") {
      this.snapshot.metadata = {
        ...(this.snapshot.metadata ?? {}),
        ...(delta["metadata"] as Record<string, unknown>),
      };
    }
    if (delta["inputs"] !== null && typeof delta["inputs"] === "object") {
      this.snapshot.inputs = {
        ...(this.snapshot.inputs ?? {}),
        ...(delta["inputs"] as Record<string, unknown>),
      };
    }
  }

  private buildSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.snapshot.teamWorkflowStatus !== undefined) {
      out["teamWorkflowStatus"] = this.snapshot.teamWorkflowStatus;
    }
    if (this.snapshot.agents.size > 0) {
      out["agents"] = Array.from(this.snapshot.agents.values());
    }
    if (this.snapshot.tasks.size > 0) {
      out["tasks"] = Array.from(this.snapshot.tasks.values());
    }
    if (this.snapshot.metadata !== undefined) {
      out["metadata"] = this.snapshot.metadata;
    }
    if (this.snapshot.inputs !== undefined) {
      out["inputs"] = this.snapshot.inputs;
    }
    if (this.snapshot.controlPlane !== undefined) {
      out["controlPlane"] = { ...this.snapshot.controlPlane };
    }
    return out;
  }

  private sendSnapshot(socket: Socket): void {
    const snap = this.buildSnapshot();
    if (Object.keys(snap).length > 0) {
      socket.emit(STATE_EVENT, snap);
    }
  }

  private handleHitlDecision(
    socket: Socket,
    sentAt: number[],
    payload: unknown,
    ack?: HitlAck,
  ): void {
    const error = hitlPayloadError(payload, this.validDecisions);
    if (error) {
      ack?.({ ok: false, error });
      return;
    }
    const now = Date.now();
    while (sentAt.length > 0 && now - sentAt[0]! >= HITL_WINDOW_MS)
      sentAt.shift();
    if (sentAt.length >= HITL_MAX_PER_WINDOW) {
      ack?.({ ok: false, error: "rate limited" });
      return;
    }
    sentAt.push(now);
    const { taskId, decision } = payload as {
      taskId: string;
      decision: string;
    };
    const subject = socket.data["sub"] as string | undefined;
    log.info(
      { decision, taskId: taskId.slice(-8), ...(subject ? { subject } : {}) },
      "HITL decision received",
    );
    this.forwardHitlDecision(taskId, decision, ack);
  }

  /** Board → emergency STOP ALL; the ingress authenticates, limits and issues it. */
  private async handleStopAll(
    control: EmergencyStopIngress,
    socket: Socket,
    payload: unknown,
    ack?: StopAllAck,
  ): Promise<void> {
    const token = socket.handshake.auth["token"] as string | undefined;
    const result = await control.stopAll(token, payload, socket.handshake.address);
    if (result.ok) ack?.({ ...result });
    else ack?.({ ok: false, error: result.error });
  }

  /** Seed the snapshot with the stop saved before this gateway started. */
  private async seedLastStop(control: EmergencyStopIngress): Promise<void> {
    const saved = await control.lastStop();
    // Set in the constructor whenever `control` is; a live delta may already be newer.
    const plane = this.snapshot.controlPlane!;
    if (saved && !plane.lastStop) plane.lastStop = stopOfAck(saved)!;
  }

  /**
   * Dual delivery: write the durable per-task list FIRST (the reliable BRPOP
   * fallback — no timing dependency), then publish on pub/sub (the fast path).
   * ACK the board only after the reliable path is persisted, so a pub/sub
   * message the orchestrator connects too late to receive is always recoverable
   * via BRPOP. If either write fails, tell the board to retry rather than
   * silently dropping the decision.
   */
  private forwardHitlDecision(
    taskId: string,
    decision: string,
    ack?: HitlAck,
  ): void {
    const msg = wrapSigned({ taskId, decision });
    const listKey = `${HITL_CHANNEL}:${taskId}`;
    this.hitlPublisher
      .lpush(listKey, msg)
      .then(() => this.hitlPublisher.expire(listKey, 300))
      .then(() => this.hitlPublisher.publish(HITL_CHANNEL, msg))
      .then(() => {
        log.info(
          { decision, taskId: taskId.slice(-8) },
          "HITL decision forwarded to Redis (list + pub/sub)",
        );
        ack?.({ ok: true });
      })
      .catch((err: unknown) => {
        log.error({ err }, "Failed to forward HITL decision to Redis");
        ack?.({ ok: false, error: "Redis write failed" });
      });
  }

  // ─── Initialisation ───────────────────────────────────────────────────────

  public initialize(): void {
    const rawOrigins = process.env["SOCKET_CORS_ORIGINS"];
    if (!rawOrigins && process.env["NODE_ENV"] === "production") {
      throw new Error(
        "SOCKET_CORS_ORIGINS must be set in production — refusing wildcard CORS",
      );
    }
    const allowedOrigins = rawOrigins?.split(",").map((s) => s.trim()) ?? ["*"];

    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: allowedOrigins, credentials: true },
      maxHttpBufferSize: 1e6, // 1 MB — prevent oversized WebSocket frames
      pingTimeout: 20_000, // Disconnect dead clients after 20s without pong
      pingInterval: 25_000, // Ping every 25s to detect dead connections
    });
    this.io.adapter(createAdapter(this.redisPublisher, this.redisSubscriber));

    // Auth middleware — runs before any 'connection' handler.
    // Gated: only enforced when BOARD_JWT_SECRET is set.
    this.io.use((socket, next) => {
      if (!process.env["BOARD_JWT_SECRET"]) return next(); // auth disabled
      try {
        const token = socket.handshake.auth["token"] as string | undefined;
        if (!token) return next(new Error("Missing board token"));
        const payload = verifyBoardToken(token);
        socket.data["exp"] = payload["exp"];
        if (typeof payload["sub"] === "string")
          socket.data["sub"] = payload["sub"];
        next();
      } catch {
        next(new Error("Invalid or expired board token"));
      }
    });

    this.io.on("connection", (socket: Socket) => {
      // Enforce token expiry on long-running connections
      const exp = socket.data["exp"] as number | undefined;
      if (exp !== undefined) {
        const msUntilExpiry = exp * 1000 - Date.now();
        if (msUntilExpiry <= 0) {
          socket.disconnect(true);
          return;
        }
        const expiryTimer = setTimeout(
          () => socket.disconnect(true),
          msUntilExpiry,
        );
        // Clear the expiry timer if the client disconnects first, so it doesn't
        // linger (holding a closure over the dead socket) until token expiry.
        socket.on("disconnect", () => clearTimeout(expiryTimer));
      }

      // Replay current full state to newly connected / reconnected client
      this.sendSnapshot(socket);

      // Client can explicitly request a state refresh (e.g. after reconnect)
      socket.on(STATE_EVENT_REQUEST, () => this.sendSnapshot(socket));

      // Forward HITL decisions from board → Redis → orchestrator.
      // The optional ack callback lets the board confirm delivery end-to-end.
      const sentAt: number[] = []; // per-connection rate window
      socket.on(HITL_SOCKET_EVENT, (payload: unknown, ack?: HitlAck) =>
        this.handleHitlDecision(socket, sentAt, payload, ack),
      );

      // Emergency STOP ALL (ADR-025) — only with the control plane on.
      const control = this.control;
      if (control) {
        socket.on(CONTROL_STOP_ALL_EVENT, (payload: unknown, ack?: StopAllAck) =>
          void this.handleStopAll(control, socket, payload, ack),
        );
      }
    });
    if (this.control) void this.seedLastStop(this.control);

    this.redisSubscriber.subscribe(STATE_CHANNEL);
    this.redisSubscriber.on("message", (_channel: string, data: string) => {
      try {
        const parsed = unwrapVerified(data);
        if (!parsed) {
          log.warn("Rejected unsigned/invalid channel message");
          return;
        }
        this.applyToSnapshot(parsed); // keep snapshot current
        this.io?.emit(STATE_EVENT, parsed); // broadcast incremental delta to all
      } catch {
        log.error("Failed to parse state message");
      }
    });
  }

  public async shutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.io) {
        this.io.close(() => resolve());
      } else {
        resolve();
      }
    });
    await this.redisPublisher.quit();
    await this.redisSubscriber.quit();
    if (this.hitlPublisher !== this.redisPublisher) {
      await this.hitlPublisher.quit();
    }
  }
}
