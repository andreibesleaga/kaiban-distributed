import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/kafka-driver.test.ts'],
    globalSetup: './tests/e2e/setup/globalSetup.ts',
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
