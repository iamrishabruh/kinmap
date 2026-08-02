import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `scripts/` is not a workspace package, so this suite is run explicitly:
 *
 *   pnpm exec vitest run --config scripts/apple/vitest.config.mts
 *
 * `root` is pinned to this directory so that command works from anywhere in the
 * repository — Vite would otherwise resolve `include` against the caller's cwd.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    passWithNoTests: false,
  },
});
