/**
 * Shared helper to build security dependencies from environment variables.
 * Used by both src/main/index.ts and blog-team example nodes so security
 * features are available wherever AgentActor is instantiated.
 */
import type { AgentActorDeps } from '../../src/application/actor/AgentActor';
import type { ITokenProvider } from '../../src/domain/security/token-provider';
import { HeuristicFirewall } from '../../src/infrastructure/security/heuristic-firewall';
import { SlidingWindowBreaker } from '../../src/infrastructure/security/sliding-window-breaker';
import { EnvTokenProvider } from '../../src/infrastructure/security/env-token-provider';

function getBoolEnv(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultValue;
  return val === 'true' || val === '1';
}

export function buildSecurityDeps(): { actorDeps: AgentActorDeps; tokenProvider?: ITokenProvider } {
  const firewallEnabled = getBoolEnv('SEMANTIC_FIREWALL_ENABLED', false);
  const circuitBreakerEnabled = getBoolEnv('CIRCUIT_BREAKER_ENABLED', false);
  const jitTokensEnabled = getBoolEnv('JIT_TOKENS_ENABLED', false);

  const threshold = parseInt(process.env['CIRCUIT_BREAKER_THRESHOLD'] ?? '10', 10);
  const windowMs = parseInt(process.env['CIRCUIT_BREAKER_WINDOW_MS'] ?? '60000', 10);

  const actorDeps: AgentActorDeps = {
    firewall: firewallEnabled ? new HeuristicFirewall() : undefined,
    circuitBreaker: circuitBreakerEnabled ? new SlidingWindowBreaker(threshold, windowMs) : undefined,
  };

  const tokenProvider = jitTokensEnabled ? new EnvTokenProvider() : undefined;

  if (firewallEnabled) console.log('[Security] Semantic Firewall ENABLED');
  if (circuitBreakerEnabled) console.log(`[Security] Circuit Breaker ENABLED (threshold=${threshold}, window=${windowMs}ms)`);
  if (jitTokensEnabled) console.log('[Security] JIT Token Provider ENABLED');

  return { actorDeps, tokenProvider };
}
