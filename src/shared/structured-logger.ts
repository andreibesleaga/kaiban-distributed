import pino from "pino";

/**
 * Structured (JSON) logger for production worker / infrastructure paths.
 *
 * Human-facing CLI/demo output (separators, headers, HITL prompts) stays on
 * `createLogger` in `./logger`. This logger emits one JSON object per line with
 * a level, timestamp, the service name, and any child bindings — suitable for
 * ingestion by Loki/ELK/Datadog and correlation with OpenTelemetry traces.
 *
 * - Level from `LOG_LEVEL` (default `info`); `silent` under tests for clean output.
 * - PII-sensitive fields are redacted.
 */
export function resolveLogLevel(
  env: NodeJS.ProcessEnv = process.env,
): pino.Level | "silent" {
  const explicit = env["LOG_LEVEL"];
  if (explicit) return explicit as pino.Level;
  const isTest = env["VITEST"] === "true" || env["NODE_ENV"] === "test";
  return isTest ? "silent" : "info";
}

/**
 * Build the pino options. JSON by default (production-grade); set `LOG_PRETTY=true`
 * for human-readable colourised output in local dev / demos (requires `pino-pretty`).
 */
export function buildPinoOptions(
  env: NodeJS.ProcessEnv = process.env,
): pino.LoggerOptions {
  const options: pino.LoggerOptions = {
    level: resolveLogLevel(env),
    base: { service: env["SERVICE_NAME"] ?? "kaiban-distributed" },
    redact: {
      paths: [
        "password",
        "token",
        "secret",
        "apiKey",
        "api_key",
        "email",
        "phone",
        "ssn",
        "*.password",
        "*.token",
        "*.secret",
        "*.apiKey",
      ],
      censor: "[redacted]",
    },
  };
  if (env["LOG_PRETTY"] === "true") {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, ignore: "pid,hostname" },
    };
  }
  return options;
}

export const logger = pino(buildPinoOptions());

/**
 * Create a child logger with persistent bindings (e.g. `{ component, agentId }`)
 * so every line it emits carries that context.
 */
export function createStructuredLogger(
  bindings: Record<string, unknown>,
): pino.Logger {
  return logger.child(bindings);
}
