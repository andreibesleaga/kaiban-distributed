/**
 * Vitest config for security-enabled E2E tests.
 *
 * Runs tests/e2e/security-full-stack.test.ts against a real Redis instance
 * that has a password, with ALL security features enabled via environment
 * variables:
 *
 *   REDIS_PASSWORD          — Redis requirepass
 *   A2A_JWT_SECRET          — enables POST /a2a/rpc bearer-token auth
 *   BOARD_JWT_SECRET        — enables Socket.io JWT middleware
 *   CHANNEL_SIGNING_SECRET  — enables HMAC-SHA256 Redis pub/sub signing
 *   NODE_ENV=production     — enables error sanitization + CORS enforcement
 *   SEMANTIC_FIREWALL_ENABLED / CIRCUIT_BREAKER_ENABLED — feature flags
 *
 * Usage:
 *   npm run test:e2e:security
 *
 * Requires Docker (Redis started by globalSetup/securitySetup.ts).
 */
import { defineConfig } from 'vitest/config';

/** Must match SECURITY_TEST_REDIS_PASSWORD in securitySetup.ts */
const REDIS_PASSWORD = 'e2e-sec-redis-pass-32chars!!!!!';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    include: ['tests/e2e/security-full-stack.test.ts'],
    globalSetup: './tests/e2e/setup/securitySetup.ts',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      REDIS_PASSWORD,
      REDIS_URL: `redis://:${REDIS_PASSWORD}@localhost:6380`,

      // Auth secrets — activates all three security gates
      A2A_JWT_SECRET: 'e2e-a2a-secret-must-be-32-chars!!',
      BOARD_JWT_SECRET: 'e2e-board-secret-must-32-chars!!!',
      CHANNEL_SIGNING_SECRET: 'e2e-channel-secret-32bytes!!!!!',

      // Runtime flags
      NODE_ENV: 'production',
      TRUST_PROXY: 'false',
      SEMANTIC_FIREWALL_ENABLED: 'true',
      CIRCUIT_BREAKER_ENABLED: 'true',
      JIT_TOKENS_ENABLED: 'true',
    },
  },
});
