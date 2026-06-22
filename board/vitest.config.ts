import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
    // Playwright specs under e2e/ run via `npm run test:visual`, not vitest.
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
});
