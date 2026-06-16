import { defineConfig } from 'vitest/config';

// Isolated chaos / broker fault-injection suite. Kept separate from the main
// e2e config because it pauses the shared Redis container mid-test — it must
// never run concurrently with other e2e tests. The main config excludes
// `tests/e2e/chaos/**`; this one runs only that directory, single-file.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    include: ['tests/e2e/chaos/**/*.test.ts'],
    globalSetup: './tests/e2e/setup/globalSetup.ts',
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
