/**
 * Security dependencies builder — shared across all examples.
 *
 * Reads security feature flags from environment variables and constructs
 * the appropriate dependencies for AgentActor + task handlers.
 *
 * Environment variables:
 *   SEMANTIC_FIREWALL_ENABLED=true  → HeuristicFirewall (prompt-injection guard)
 *   CIRCUIT_BREAKER_ENABLED=true    → SlidingWindowBreaker
 *   CIRCUIT_BREAKER_THRESHOLD=10    → failures before tripping (default 10)
 *   CIRCUIT_BREAKER_WINDOW_MS=60000 → rolling window in ms (default 60s)
 *   JIT_TOKENS_ENABLED=true         → EnvTokenProvider (per-task API key injection)
 */
import type { AgentActorDeps } from "../application/actor/AgentActor";
import type { ITokenProvider } from "../domain/security/token-provider";
import { HeuristicFirewall } from "../infrastructure/security/heuristic-firewall";
import { SlidingWindowBreaker } from "../infrastructure/security/sliding-window-breaker";
import { EnvTokenProvider } from "../infrastructure/security/env-token-provider";
import { createLogger } from "./logger";

const log = createLogger("Security");

/** Safe boolean environment variable reader. */
export function getBoolEnv(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultValue;
  return val === "true" || val === "1";
}

/**
 * Builds security dependencies from environment variables.
 *
 * Returns:
 *  - `actorDeps` — passed to AgentActor constructor
 *  - `tokenProvider` — passed to createKaibanTaskHandler (may be undefined)
 */
export function buildSecurityDeps(): {
  actorDeps: AgentActorDeps;
  tokenProvider?: ITokenProvider;
} {
  const firewallEnabled = getBoolEnv("SEMANTIC_FIREWALL_ENABLED", false);
  const circuitBreakerEnabled = getBoolEnv("CIRCUIT_BREAKER_ENABLED", false);
  const jitTokensEnabled = getBoolEnv("JIT_TOKENS_ENABLED", false);

  const threshold = parseInt(
    process.env["CIRCUIT_BREAKER_THRESHOLD"] ?? "10",
    10,
  );
  const windowMs = parseInt(
    process.env["CIRCUIT_BREAKER_WINDOW_MS"] ?? "60000",
    10,
  );

  const actorDeps: AgentActorDeps = {
    firewall: firewallEnabled ? new HeuristicFirewall() : undefined,
    circuitBreaker: circuitBreakerEnabled
      ? new SlidingWindowBreaker(threshold, windowMs)
      : undefined,
  };

  const tokenProvider = jitTokensEnabled ? new EnvTokenProvider() : undefined;

  if (firewallEnabled) log.info("Semantic Firewall ENABLED");
  if (circuitBreakerEnabled)
    log.info(
      `Circuit Breaker ENABLED (threshold=${threshold}, window=${windowMs}ms)`,
    );
  if (jitTokensEnabled) log.info("JIT Token Provider ENABLED");

  return { actorDeps, tokenProvider };
}
