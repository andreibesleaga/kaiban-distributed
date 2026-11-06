// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "fs";

/** Client-certificate TLS material for Redis and Kafka (mTLS). */
export interface TlsConfig {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  rejectUnauthorized: boolean;
}

/**
 * Reads the CA, certificate and key files. All three paths must be set,
 * otherwise there is no mTLS configuration and the result is `undefined`.
 * `TLS_REJECT_UNAUTHORIZED=false` (or `0`) turns server verification off.
 */
export function loadTlsConfig(
  caPath?: string,
  certPath?: string,
  keyPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): TlsConfig | undefined {
  if (!caPath || !certPath || !keyPath) return undefined;
  // Verification stays on unless the documented opt-out literal is given; a
  // mistyped value ("True", "no", "off") must not silently disable it.
  const reject = (env["TLS_REJECT_UNAUTHORIZED"] ?? "").trim().toLowerCase();
  return {
    ca: readFileSync(caPath),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    rejectUnauthorized: !(reject === "false" || reject === "0"),
  };
}

/** The TLS settings for Redis, from `REDIS_TLS_CA` / `_CERT` / `_KEY`. */
export function redisTlsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TlsConfig | undefined {
  return loadTlsConfig(
    env["REDIS_TLS_CA"],
    env["REDIS_TLS_CERT"],
    env["REDIS_TLS_KEY"],
    env,
  );
}

/** The TLS settings for Kafka, from `KAFKA_SSL_CA` / `_CERT` / `_KEY`. */
export function kafkaSslFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TlsConfig | undefined {
  return loadTlsConfig(
    env["KAFKA_SSL_CA"],
    env["KAFKA_SSL_CERT"],
    env["KAFKA_SSL_KEY"],
    env,
  );
}
