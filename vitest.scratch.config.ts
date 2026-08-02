import path from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Scratch harness: the services are not installed into node_modules yet
 * (pnpm install has not run), so @family/* is aliased straight at the package
 * sources to exercise the domain tests.
 */
const root = '/Users/rishabh/family-location';

const pkg = (name: string): string => path.join(root, 'packages', name, 'src', 'index.ts');

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@family/contracts': pkg('contracts'),
      '@family/schemas': pkg('schemas'),
      '@family/validation': pkg('validation'),
      '@family/auth': pkg('auth'),
      '@family/observability': pkg('observability'),
      '@family/crypto': pkg('crypto'),
      '@family/location-core': pkg('location-core'),
      '@family/test-utils': pkg('test-utils'),
    },
  },
  test: {
    environment: 'node',
    include: ['services/*/tests/**/*.test.ts'],
    passWithNoTests: false,
  },
});
