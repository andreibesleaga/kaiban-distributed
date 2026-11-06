// SPDX-License-Identifier: Apache-2.0
/**
 * The `kaiban-control` channel (roadmap §6.10, ADR-025): the emergency STOP ALL.
 *
 * A stop is a moment (`issuedAt`): every task sent at or before it ends, and
 * anything sent after it runs normally. The latest stop is saved in Redis
 * (`kaiban-control:stopped-at`) before it is published, so a node that missed
 * the message, or starts later, reads it on start and on every reconnect.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { Redis } from "ioredis";
import { createRedisClient } from "../../shared/redis-connection";
import { z } from "zod";
import { CONTROL_CHANNEL } from "../messaging/channels";
import { unwrapVerified, wrapSigned } from "../security/channel-signing";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "ControlChannel" });

/**
 * Redis key holding the latest STOP_ALL command (JSON, no TTL). With
 * CHANNEL_SIGNING_SECRET set the stored command carries a durable `sig`
 * (HMAC-SHA256, no freshness limit), checked before it is replayed.
 */
export const STOP_MOMENT_KEY = "kaiban-control:stopped-at";

/** Separates saved-command signatures from the live channel's envelope signatures. */
const SAVED_SIGNATURE_DOMAIN = "kaiban-control-saved.";

/** The only command 2.1.0 knows: stop everything sent up to `issuedAt`. */
export const StopAllCommandSchema = z
  .object({
    commandId: z.string().min(1).max(100),
    command: z.literal("STOP_ALL"),
    issuedBy: z.string().min(1).max(200),
    /** The stop moment, epoch milliseconds. */
    issuedAt: z.number().int().positive(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type StopAllCommand = z.infer<typeof StopAllCommandSchema>;

/**
 * What a node (or the gateway, `issued`) reports for a STOP_ALL, on the state
 * channel as a `control` delta (ES-9). `aborted` = running tasks it killed.
 */
export interface ControlAck {
  commandId: string;
  issuedAt: number;
  issuedBy: string;
  reason?: string;
  nodeId: string;
  agentId?: string;
  outcome: "applied" | "noop" | "issued";
  aborted: number;
  /** When the node handled it, epoch ms. */
  at: number;
}

/** The value as a STOP_ALL command, or null when it is not a valid one. */
export function parseStopAllCommand(value: unknown): StopAllCommand | null {
  const parsed = StopAllCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function savedSignature(canonical: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(SAVED_SIGNATURE_DOMAIN + canonical)
    .digest("hex");
}

/**
 * The value to save under STOP_MOMENT_KEY: the command (in schema key order),
 * plus a durable signature when CHANNEL_SIGNING_SECRET is set.
 */
export function sealStopCommand(cmd: StopAllCommand): string {
  const canonical = JSON.stringify(StopAllCommandSchema.parse(cmd));
  const secret = process.env["CHANNEL_SIGNING_SECRET"];
  if (!secret) return canonical;
  return JSON.stringify({ ...JSON.parse(canonical), sig: savedSignature(canonical, secret) });
}

/**
 * A saved command, or null when it is not valid JSON, not a STOP_ALL, or —
 * with CHANNEL_SIGNING_SECRET set — unsigned or wrongly signed.
 */
export function openSavedStopCommand(raw: string): StopAllCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { sig, ...fields } = value as Record<string, unknown>;
  const cmd = parseStopAllCommand(fields);
  if (!cmd) return null;
  const secret = process.env["CHANNEL_SIGNING_SECRET"];
  if (!secret) return cmd;
  return typeof sig === "string" && sameHex(sig, savedSignature(JSON.stringify(cmd), secret))
    ? cmd
    : null;
}

/** Constant-time comparison of two hex strings of any length. */
function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The Redis calls `issueStopAll` needs (an ioredis client fits). */
export interface ControlPublisher {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
}

/** The Redis call `readLastStop` needs. */
export interface ControlReader {
  get(key: string): Promise<string | null>;
}

// Save the command only if its moment is later than the saved one, atomically,
// so two near-simultaneous stops can never leave the earlier moment saved.
const SAVE_IF_LATER = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, saved = pcall(cjson.decode, current)
  if ok and type(saved) == 'table' and tonumber(saved.issuedAt) and tonumber(saved.issuedAt) >= tonumber(ARGV[1]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

/**
 * Issue a STOP_ALL: save it as the latest stop (if it is later than the saved
 * one), then publish it signed on the control channel. `saved: false` means a
 * later stop was already saved; the message is still published.
 */
export async function issueStopAll(
  redis: ControlPublisher,
  cmd: StopAllCommand,
): Promise<{ saved: boolean }> {
  if (!parseStopAllCommand(cmd)) throw new Error("Invalid STOP_ALL command");
  const saved = await redis.eval(
    SAVE_IF_LATER,
    1,
    STOP_MOMENT_KEY,
    String(cmd.issuedAt),
    sealStopCommand(cmd),
  );
  await redis.publish(CONTROL_CHANNEL, wrapSigned({ ...cmd }));
  return { saved: saved === 1 };
}

/**
 * The latest saved STOP_ALL, or null when none is saved or the saved value is
 * unreadable or fails verification (logged). A Redis error rejects.
 */
export async function readLastStop(
  redis: ControlReader,
): Promise<StopAllCommand | null> {
  const raw = await redis.get(STOP_MOMENT_KEY);
  if (raw === null) return null;
  const cmd = openSavedStopCommand(raw);
  if (!cmd) {
    log.warn(
      { key: STOP_MOMENT_KEY },
      "Ignored a saved emergency stop that is invalid, unsigned or fails verification",
    );
  }
  return cmd;
}

/** Where a command came from: the channel, or the saved key (start / reconnect). */
export type StopSource = "channel" | "saved";

export interface ControlSubscriberOptions {
  redisUrl: string;
  /** Called for each valid STOP_ALL; it must be idempotent (repeats happen). */
  onStop: (cmd: StopAllCommand, source: StopSource) => void;
  /** Base wait between retries of a failed saved-stop read after a reconnect (default 1 000 ms). */
  retryDelayMs?: number;
}

/**
 * Subscribes to the control channel and replays the saved stop on start and on
 * every reconnect. Two connections: a subscriber (pub/sub mode cannot GET) and
 * a reader for the saved key. `start()` fails closed: it rejects when the
 * saved stop cannot be read, so a node never takes tasks without the cutoff.
 * A failed read after a reconnect is retried until it succeeds or `close()`.
 */
export class ControlSubscriber {
  private subscriber: Redis | null = null;
  private reader: Redis | null = null;

  constructor(private readonly opts: ControlSubscriberOptions) {}

  async start(): Promise<void> {
    const subscriber = createRedisClient(this.opts.redisUrl, { lazyConnect: false });
    const reader = createRedisClient(this.opts.redisUrl, { lazyConnect: false });
    this.subscriber = subscriber;
    this.reader = reader;
    for (const client of [subscriber, reader]) {
      client.on("error", (err: unknown) =>
        log.warn({ err }, "Control channel Redis error"),
      );
    }
    subscriber.on("message", (_channel: string, raw: string) =>
      this.onMessage(raw),
    );
    // 'ready' fires again after every reconnect: catch up on a missed stop.
    subscriber.on("ready", () => void this.catchUp());
    await subscriber.subscribe(CONTROL_CHANNEL);
    await this.replaySaved();
  }

  async close(): Promise<void> {
    await this.subscriber?.quit();
    await this.reader?.quit();
    this.subscriber = null;
    this.reader = null;
  }

  private onMessage(raw: string): void {
    let payload: Record<string, unknown> | null;
    try {
      payload = unwrapVerified(raw);
    } catch {
      payload = null; // never let a malformed message escape into ioredis
    }
    if (!payload) {
      log.warn(
        { channel: CONTROL_CHANNEL },
        "Ignored a control message that is unsigned or fails verification",
      );
      return;
    }
    const cmd = parseStopAllCommand(payload);
    if (!cmd) {
      log.warn({ channel: CONTROL_CHANNEL }, "Ignored an invalid control command");
      return;
    }
    this.deliver(cmd, "channel");
  }

  /** Read the saved stop and deliver it; a Redis error rejects. */
  private async replaySaved(): Promise<void> {
    /* v8 ignore next — close() raced a reconnect's 'ready' */
    if (!this.reader) return;
    const cmd = await readLastStop(this.reader);
    if (cmd) this.deliver(cmd, "saved");
  }

  /** After a reconnect: replay the saved stop, retrying until it succeeds or close(). */
  private async catchUp(): Promise<void> {
    const base = this.opts.retryDelayMs ?? 1_000;
    for (let attempt = 1; this.reader; attempt++) {
      try {
        await this.replaySaved();
        return;
      } catch (err) {
        log.warn({ err, attempt }, "Could not read the saved emergency stop — retrying");
        await new Promise((r) => setTimeout(r, base * Math.min(attempt, 5)));
      }
    }
  }

  private deliver(cmd: StopAllCommand, source: StopSource): void {
    try {
      this.opts.onStop(cmd, source);
    } catch (err) {
      log.error({ err }, "Emergency stop handler failed");
    }
  }
}
