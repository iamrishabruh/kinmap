// Root flat config. Each area of the monorepo gets the config matching its
// runtime; the privacy rules (no coordinates reaching a logging or telemetry
// sink) are enforced everywhere by @family/eslint-config.
import { cli, node, reactNative, services } from '@family/eslint-config';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      '**/build/**',
      '**/coverage/**',
      '**/cdk.out/**',
      '**/.expo/**',
      '**/.turbo/**',
      '**/.bootstrap-state/**',
      'apps/mobile/ios/**',
      'apps/mobile/android/**',
      '**/*.d.ts',
    ],
  },

  ...node.map((config) => ({
    ...config,
    files: ['packages/**/*.{ts,tsx}', 'infrastructure/**/*.ts'],
  })),

  // Scripts are operator-facing command-line tools: their stdout is the UI.
  ...cli.map((config) => ({
    ...config,
    files: ['scripts/**/*.ts'],
  })),

  ...services.map((config) => ({
    ...config,
    files: ['services/**/*.ts'],
  })),

  ...reactNative.map((config) => ({
    ...config,
    files: ['apps/mobile/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
  })),

  {
    // Tests assert on redaction behaviour, so they legitimately construct the
    // very shapes the privacy rules ban in production code.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', '**/test-utils/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
