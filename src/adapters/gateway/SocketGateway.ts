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

/** Snapshot requests accepted per connection per window (each re-sends the whole snapshot). */
const SNAPSHOT_MAX_PER_WINDOW = 5;
const SNAPSHOT_WINDOW_MS = 10_000;
/** The longest delay `setTimeout` honours; larger values fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

type HitlAck = (response: { ok: boolean; error?: string }) => void;
type StopAllAck = (response: Record<string, unknown>) => void;

/**
 * The client's acknowledgement callback, or undefined. Socket.io hands the
 * handler whatever the client sent last, so a string or object must never be
 * called (a `TypeError` there would take the gateway process down).
 */
function ackOf<F>(candidate: unknown): F | undefined {
  return typeof candidate === "function" ? (candidate as F) : undefined;
}

/**
 * Admit one event for a connection: true when fewer than `max` events were
 * admitted in the last `windowMs`. `sentAt` is the connection's own window.
 */
function admit(sentAt: number[], max: number, windowMs: number): boolean {
  const now = Date.now();
  while (sentAt.length > 0 && now - sentAt[0]! >= windowMs) sentAt.shift();
  if (sentAt.length >= max) return false;
  sentAt.push(now);
  return true;
}

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

/** A request without an Origin header (not a browser) or from a listed origin. */
function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  return origin === undefined || allowed.includes(origin);
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
  /** Behind one trusted proxy: key rate limits by `X-Forwarded-For` (as Express does). */
  private trustProxy: boolean;

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
      trustProxy?: boolean;
    },
  ) {
    this.httpServer = httpServer;
    this.redisPublisher = redisPublisher;
    this.redisSubscriber = redisSubscriber;
    this.hitlPublisher = opts?.hitlPublisher ?? redisPublisher;
    this.validDecisions = opts?.validHitlDecisions ?? DEFAULT_DECISIONS;
    this.control = opts?.control;
    this.trustProxy = opts?.trustProxy ?? false;
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
      // The new run's own metadata and inputs arrive in this or later deltas;
      // the old run's totals and end time must not leak into replays.
      delete this.snapshot.metadata;
      delete this.snapshot.inputs;
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
    if (!admit(sentAt, HITL_MAX_PER_WINDOW, HITL_WINDOW_MS)) {
      ack?.({ ok: false, error: "rate limited" });
      return;
    }
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

  /**
   * The address rate limits are keyed by. Behind one trusted proxy
   * (`TRUST_PROXY`) that is the last `X-Forwarded-For` entry, the same address
   * Express uses for `req.ip`; otherwise the socket's own address.
   */
  private clientKeyOf(socket: Socket): string {
    if (this.trustProxy) {
      const header = socket.handshake.headers?.["x-forwarded-for"];
      const forwarded = (Array.isArray(header) ? header.join(",") : header)
        ?.split(",")
        .pop()
        ?.trim();
      if (forwarded) return forwarded;
    }
    return socket.handshake.address;
  }

  /** Board → emergency STOP ALL; the ingress authenticates, limits and issues it. */
  private async handleStopAll(
    control: EmergencyStopIngress,
    socket: Socket,
    payload: unknown,
    ack?: StopAllAck,
  ): Promise<void> {
    try {
      const token = socket.handshake.auth["token"] as string | undefined;
      const key = this.clientKeyOf(socket);
      const result = await control.stopAll(token, payload, key);
      if (result.ok) ack?.({ ...result });
      else ack?.({ ok: false, error: result.error });
    } catch (err) {
      log.error({ err }, "Emergency stop failed");
      ack?.({ ok: false, error: "Emergency stop failed" });
    }
  }

  /**
   * A STOP_ALL seen on the control channel (live, or the saved one replayed on
   * start and reconnect — so CLI-issued stops count too). A newer stop replaces
   * the last one and resets the ack count; every board gets the new state.
   */
  public noteStop(cmd: {
    commandId: string;
    issuedAt: number;
    issuedBy: string;
    reason?: string;
  }): void {
    const plane = this.snapshot.controlPlane;
    if (!plane || (plane.lastStop && plane.lastStop.issuedAt >= cmd.issuedAt)) return;
    plane.lastStop = stopOfAck(cmd)!;
    plane.acks = 0;
    // Every gateway sees the control channel itself: local only, or each board
    // would get the update once per gateway through the Redis adapter.
    this.io?.local.emit(STATE_EVENT, { controlPlane: { ...plane } });
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
    const allowedOrigins = rawOrigins?.split(",").map((s) => s.trim());

    this.io = new SocketIOServer(this.httpServer, {
      // CORS headers only cover HTTP long-polling; the WebSocket upgrade is
      // checked by `allowRequest`. Unset (development): any origin.
      cors: { origin: allowedOrigins ?? "*", credentials: true },
      ...(allowedOrigins
        ? {
            allowRequest: (req, callback): void =>
              callback(null, originAllowed(req.headers.origin, allowedOrigins)),
          }
        : {}),
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
        if (exp * 1000 - Date.now() <= 0) {
          socket.disconnect(true);
          return;
        }
        let expiryTimer: NodeJS.Timeout;
        const armExpiry = (): void => {
          // Re-arm in chunks: a delay above ~24.8 days would fire after 1 ms.
          const left = exp * 1000 - Date.now();
          if (left <= 0) {
            socket.disconnect(true);
            return;
          }
          expiryTimer = setTimeout(armExpiry, Math.min(left, MAX_TIMER_MS));
        };
        armExpiry();
        // Clear the expiry timer if the client disconnects first, so it doesn't
        // linger (holding a closure over the dead socket) until token expiry.
        socket.on("disconnect", () => clearTimeout(expiryTimer));
      }

      // Replay current full state to newly connected / reconnected client
      this.sendSnapshot(socket);

      // Client can explicitly request a state refresh (e.g. after reconnect)
      // Rate-limited: each request re-sends the whole snapshot.
      const snapshotAt: number[] = [];
      socket.on(STATE_EVENT_REQUEST, () => {
        if (admit(snapshotAt, SNAPSHOT_MAX_PER_WINDOW, SNAPSHOT_WINDOW_MS)) {
          this.sendSnapshot(socket);
        }
      });

      // Forward HITL decisions from board → Redis → orchestrator.
      // The optional ack callback lets the board confirm delivery end-to-end.
      const sentAt: number[] = []; // per-connection rate window
      socket.on(HITL_SOCKET_EVENT, (payload: unknown, ack?: unknown) =>
        this.handleHitlDecision(socket, sentAt, payload, ackOf<HitlAck>(ack)),
      );

      // Emergency STOP ALL (ADR-025) — only with the control plane on.
      const control = this.control;
      if (control) {
        socket.on(CONTROL_STOP_ALL_EVENT, (payload: unknown, ack?: unknown) =>
          void this.handleStopAll(control, socket, payload, ackOf<StopAllAck>(ack)),
        );
      }
    });

    this.redisSubscriber.subscribe(STATE_CHANNEL);
    this.redisSubscriber.on("message", (_channel: string, data: string) => {
      try {
        const parsed = unwrapVerified(data);
        if (!parsed) {
          log.warn("Rejected unsigned/invalid channel message");
          return;
        }
        this.applyToSnapshot(parsed); // keep snapshot current
        // Every gateway subscribes to the state channel itself, so deliver to
        // its own clients only; the Redis adapter would repeat it per gateway.
        this.io?.local.emit(STATE_EVENT, parsed);
      } catch {
        log.error("Failed to parse state message");
      }
    });
  }

  /** Disconnect this gateway's own board clients (shutdown: upgraded sockets never end by themselves). */
  public disconnectClients(): void {
    this.io?.local.disconnectSockets(true);
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
