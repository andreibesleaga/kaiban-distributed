// SPDX-License-Identifier: Apache-2.0
/**
 * The one place that turns `REDIS_URL` (+ `REDIS_TLS_*`) into connection
 * options. Every Redis client in this package goes through it: the BullMQ
 * task queues and each ioredis client (state, control, HITL, A2A, stop-all).
 * A password, user, db number or `rediss://` scheme in the URL therefore
 * reaches all of them, and the mTLS files reach all of them too.
 */
import { Redis, type RedisOptions } from "ioredis";
import {
  redisTlsFromEnv,
  type TlsConfig,
} from "../infrastructure/security/tls-config";

/** Connection options both BullMQ and ioredis accept. */
export type RedisConnection = RedisOptions & { host: string; port: number };

const DEFAULT_REDIS_URL = "redis://localhost:6379";

function tlsOptions(tls: TlsConfig): NonNullable<RedisOptions["tls"]> {
  return {
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    rejectUnauthorized: tls.rejectUnauthorized,
  };
}

/**
 * BullMQ connection options from a Redis URL: host, port, user, password, db
 * and TLS (`rediss://`). Only the parts the URL carries are set. Pass `tls`
 * (mTLS material) to add the client certificate.
 */
export function redisConnectionFromUrl(
  url: string = DEFAULT_REDIS_URL,
  tls?: TlsConfig,
): RedisConnection {
  const u = new URL(url);
  const db = Number(u.pathname.slice(1));
  return {
    host: u.hostname,
    port: parseInt(u.port || "6379", 10),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(Number.isInteger(db) && db > 0 ? { db } : {}),
    ...(tls
      ? { tls: tlsOptions(tls) }
      : u.protocol === "rediss:"
        ? { tls: {} }
        : {}),
  };
}

/**
 * Options for an ioredis client: `extra` plus the `REDIS_TLS_*` client
 * certificate (or the `tls` given, when the caller already loaded it). The URL itself carries password, user, db and `rediss://`.
 */
export function redisClientOptions(
  extra: RedisOptions = {},
  tls: TlsConfig | undefined = redisTlsFromEnv(),
): RedisOptions {
  return tls ? { ...extra, tls: tlsOptions(tls) } : extra;
}

/** Creates an ioredis client for `url` with the shared options. */
export function createRedisClient(
  url: string,
  extra: RedisOptions = {},
): Redis {
  return new Redis(url, redisClientOptions(extra));
}
