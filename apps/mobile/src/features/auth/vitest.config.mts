import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Test harness for the auth feature.
 *
 * It lives inside the feature rather than at the package root because the
 * mobile app has no unit-test runner of its own yet (`package.json` still says
 * `jest --passWithNoTests`, with no jest configuration anywhere), and adding
 * one is a change to a file this work does not own. Run it with:
 *
 *   pnpm --filter @family/mobile exec vitest run \
 *     --config src/features/auth/vitest.config.ts
 *
 * The Expo native modules are aliased to doubles under `__tests__/doubles`.
 * Only the modules that genuinely cannot run outside a device are replaced —
 * `expo-crypto` is backed by Node's real SHA-256 and CSPRNG, so the SRP tests
 * below exercise the actual digest construction rather than a fake of it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileSrc = path.resolve(here, '../..');
const doubles = path.join(here, '__tests__', 'doubles');

export default defineConfig({
  // Vite's cache defaults to `<root>/node_modules/.vite`, and `root` is this
  // feature directory. Left alone it would create a `node_modules` inside
  // `src/`, which Metro would then try to resolve modules out of.
  cacheDir: path.resolve(mobileSrc, '..', 'node_modules', '.vite'),
  resolve: {
    alias: [
      { find: 'expo-crypto', replacement: path.join(doubles, 'expo-crypto.ts') },
      { find: 'expo-constants', replacement: path.join(doubles, 'expo-constants.ts') },
      { find: 'expo-localization', replacement: path.join(doubles, 'expo-localization.ts') },
      { find: 'expo-secure-store', replacement: path.join(doubles, 'expo-secure-store.ts') },
      { find: 'expo-web-browser', replacement: path.join(doubles, 'expo-web-browser.ts') },
      {
        find: 'expo-apple-authentication',
        replacement: path.join(doubles, 'expo-apple-authentication.ts'),
      },
      { find: 'react-native', replacement: path.join(doubles, 'react-native.ts') },
      { find: /^@\/(.*)$/, replacement: `${mobileSrc}/$1` },
    ],
  },
  test: {
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    root: here,
    passWithNoTests: false,
  },
});
