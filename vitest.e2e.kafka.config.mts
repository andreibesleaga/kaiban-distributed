import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // One file at a time, like the BullMQ suite: files sharing one broker in
    // parallel cause consumer-group rebalances (and duplicate deliveries).
    fileParallelism: false,
    include: ['tests/e2e/*kafka*.test.ts'],
    globalSetup: './tests/e2e/setup/kafkaSetup.ts',
    testTimeout: 60000,
    hookTimeout: 180000,
  },
});
