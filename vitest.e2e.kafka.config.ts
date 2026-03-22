import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/*kafka*.test.ts'],
    globalSetup: './tests/e2e/setup/kafkaSetup.ts',
    testTimeout: 60000,
    hookTimeout: 180000,
  },
});
