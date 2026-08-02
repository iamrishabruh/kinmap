import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The reducer is safety critical: a flaky wall-clock read must fail the run
    // rather than produce an intermittently green suite.
    restoreMocks: true,
  },
});
