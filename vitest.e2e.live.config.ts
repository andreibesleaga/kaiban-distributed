/**
 * Vitest config for live E2E tests — real LLM + Docker services.
 *
 * Unlike the mock-based BullMQ E2E tests, these tests:
 *   - Require Docker to be running
 *   - Make real LLM API calls (OpenRouter / OpenAI)
 *   - Have long timeouts (up to 10 min per scenario)
 *   - Are run sequentially (single fork) to avoid port conflicts
 *
 * Run: npm run test:e2e:live
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include:     ['tests/e2e/global-research-live.test.ts'],
    globalSetup: ['tests/e2e/setup/globalSetup.live.ts'],
    testTimeout:  600_000,   // 10 minutes per test
    hookTimeout:  180_000,   // 3 minutes for setup / teardown
    pool:         'forks',
    poolOptions:  { forks: { singleFork: true } },
    reporters:    ['verbose'],
    // Disable coverage for live tests (slow, unnecessary)
    coverage:     { enabled: false },
  },
});
