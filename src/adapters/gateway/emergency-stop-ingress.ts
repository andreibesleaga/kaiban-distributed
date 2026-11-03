// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway's emergency STOP ALL ingress (roadmap §6.10, ADR-025), shared by
 * the board socket event and `POST /control/stop-all`.
 *
 * A board token is always required: with BOARD_JWT_SECRET unset every command
 * is refused, even where the board's read-only view runs without auth (ES-6).
 * Rate-limited to 5 commands per 10 s per client (ES-10). The stop is saved and
 * published (`issueStopAll`), then announced on the state channel as an
 * `issued` ack so every connected board sees it at once (ES-9).
 */
import { STATE_CHANNEL } from "../../infrastructure/messaging/channels";
import { verifyBoardToken } from "../../infrastructure/security/board-auth";
import { wrapSigned } from "../../infrastructure/security/channel-signing";
import {
  issueStopAll,
  readLastStop,
  type ControlAck,
  type ControlPublisher,
  type ControlReader,
  type StopAllCommand,
} from "../../infrastructure/control/control-channel";
import { createStopAllCommand } from "../../shared/emergency-stop";
import { createStructuredLogger } from "../../shared/structured-logger";
import { SlidingWindowRateLimiter } from "./rate-limiter";

const log = createStructuredLogger({ component: "EmergencyStopIngress" });

/** Commands per client per window (ES-10). */
const STOP_MAX_PER_WINDOW = 5;
const STOP_WINDOW_MS = 10_000;
const MAX_REASON_LEN = 500;

/** The result of one STOP_ALL request; `status` is the HTTP status on refusal. */
export type StopAllOutcome =
  | { ok: true; commandId: string; issuedAt: number; saved: boolean }
  | { ok: false; status: 400 | 401 | 429 | 500; error: string };

type Refusal = Extract<StopAllOutcome, { ok: false }>;

const refuse = (status: Refusal["status"], error: string): Refusal => ({
  ok: false,
  status,
  error,
});

export interface EmergencyStopIngressOptions {
  /** Clock for the stop moment (tests). */
  now?: () => number;
}

export class EmergencyStopIngress {
  private readonly limiter = new SlidingWindowRateLimiter(
    STOP_WINDOW_MS,
    STOP_MAX_PER_WINDOW,
  );
  private readonly now: () => number;

  constructor(
    private readonly redis: ControlPublisher & ControlReader,
    opts: EmergencyStopIngressOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Issue a STOP_ALL for the holder of `token` (a board token). `body` may
   * carry `reason`; `clientKey` (IP or socket address) keys the rate limit.
   */
  async stopAll(
    token: string | undefined,
    body: unknown,
    clientKey: string,
  ): Promise<StopAllOutcome> {
    if (!this.limiter.isAllowed(clientKey)) return refuse(429, "Too Many Requests");
    const subject = authenticate(token);
    if (typeof subject !== "string") return subject;
    const reason = reasonOf(body);
    if (reason === false) {
      return refuse(400, `reason must be a string of at most ${MAX_REASON_LEN} characters`);
    }
    const cmd = createStopAllCommand(subject, reason, this.now());
    let saved: boolean;
    try {
      ({ saved } = await issueStopAll(this.redis, cmd));
    } catch (err) {
      log.error({ err, commandId: cmd.commandId }, "Failed to issue the emergency stop");
      return refuse(500, "Redis write failed");
    }
    log.warn(
      { subject, commandId: cmd.commandId, ...(reason ? { reason } : {}) },
      "Emergency STOP ALL issued",
    );
    this.announce(cmd);
    return { ok: true, commandId: cmd.commandId, issuedAt: cmd.issuedAt, saved };
  }

  /** The latest saved stop (null when none, or when Redis cannot be read). */
  async lastStop(): Promise<StopAllCommand | null> {
    try {
      return await readLastStop(this.redis);
    } catch {
      return null;
    }
  }

  /** Tell every board at once that a stop was issued (nodes ack separately). */
  private announce(cmd: StopAllCommand): void {
    const ack: ControlAck = {
      commandId: cmd.commandId,
      issuedAt: cmd.issuedAt,
      issuedBy: cmd.issuedBy,
      ...(cmd.reason ? { reason: cmd.reason } : {}),
      nodeId: "gateway",
      outcome: "issued",
      aborted: 0,
      at: this.now(),
    };
    this.redis
      .publish(STATE_CHANNEL, wrapSigned({ control: ack }))
      .catch((err: unknown) =>
        log.error({ err }, "Failed to publish the emergency stop ack"),
      );
  }
}

/** The token's subject, or the refusal. Control always needs a board token. */
function authenticate(token: string | undefined): string | Refusal {
  if (!process.env["BOARD_JWT_SECRET"]) {
    return refuse(401, "Emergency stop needs board authentication (BOARD_JWT_SECRET)");
  }
  if (!token) return refuse(401, "Missing board token");
  try {
    const payload = verifyBoardToken(token);
    return typeof payload["sub"] === "string" && payload["sub"] ? payload["sub"] : "board";
  } catch {
    return refuse(401, "Invalid or expired board token");
  }
}

/** The optional reason, or `false` when it is present but invalid. */
function reasonOf(body: unknown): string | undefined | false {
  const reason =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)["reason"]
      : undefined;
  if (reason === undefined || reason === "") return undefined;
  if (typeof reason !== "string" || reason.length > MAX_REASON_LEN) return false;
  return reason;
}
