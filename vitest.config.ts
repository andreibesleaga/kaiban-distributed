import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      lines: 99,
      functions: 99,
      branches: 99,
      statements: 99
    },
    include: ['tests/**/*.test.ts']
  }
});
