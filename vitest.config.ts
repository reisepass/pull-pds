import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Keep the winston logger quiet during tests unless explicitly overridden.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'error' },
    testTimeout: 15_000,
  },
});
