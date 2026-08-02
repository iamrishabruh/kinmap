// @ts-check
/**
 * Shared flat configs for the family-location monorepo.
 *
 *   import config from '@family/eslint-config';                 // base (default)
 *   import { node, reactNative, services } from '@family/eslint-config';
 *
 * `no-restricted-syntax` cannot be merged across flat-config entries — the last
 * config wins outright — so every exported config re-states the full selector
 * list rather than layering it.
 */
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

import { coordinateLoggingRules, noConsoleLogRules } from './rules/privacy.js';

const importXFlatConfigs = importX.flatConfigs ?? {};
// Only `recommended` is spread here. The plugin's `typescript` preset points at
// the legacy `import-x/resolver` interface, which eslint-import-resolver-typescript
// v4 no longer implements; the modern resolver is wired via `resolver-next` below.
const importXShared = [importXFlatConfigs.recommended].filter(Boolean);

const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/cdk.out/**',
  '**/.expo/**',
  '**/.turbo/**',
  '**/*.snap',
  '**/ios/**',
  '**/android/**',
];

/**
 * Globals are declared inline rather than pulled from the `globals` package so
 * that this config has exactly the dependency set the monorepo pins.
 */
const SHARED_GLOBALS = {
  console: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  FormData: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  globalThis: 'readonly',
};

const NODE_GLOBALS = {
  ...SHARED_GLOBALS,
  process: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'writable',
  require: 'readonly',
  exports: 'writable',
};

const REACT_NATIVE_GLOBALS = {
  ...SHARED_GLOBALS,
  __DEV__: 'readonly',
  global: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly',
  cancelIdleCallback: 'readonly',
  navigator: 'readonly',
  WebSocket: 'readonly',
  XMLHttpRequest: 'readonly',
  Blob: 'readonly',
  alert: 'readonly',
  window: 'readonly',
  document: 'readonly',
};

const SHARED_RULES = {
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-implicit-coercion': ['error', { boolean: false }],
  'no-param-reassign': 'error',
  'object-shorthand': ['error', 'properties'],
  'no-restricted-syntax': ['error', ...coordinateLoggingRules],
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
  'import-x/order': [
    'error',
    {
      groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
      pathGroups: [{ pattern: '@family/**', group: 'internal', position: 'before' }],
      pathGroupsExcludedImportTypes: ['builtin'],
      'newlines-between': 'always',
      alphabetize: { order: 'asc', caseInsensitive: true },
    },
  ],
  'import-x/no-duplicates': 'error',
  'import-x/no-cycle': ['error', { maxDepth: 4 }],
  // Source files use NodeNext resolution and therefore import with a `.js`
  // specifier that resolves to a `.ts` file; import-x cannot follow that.
  'import-x/no-unresolved': 'off',
  'import-x/named': 'off',
};

/** Base config: applies everywhere, framework-agnostic. */
export const base = tseslint.config(
  { ignores: IGNORES },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...importXShared,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: SHARED_GLOBALS,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    settings: {
      // TypeScript-aware resolution so importing a workspace package that is
      // not in the importer's dependencies is reported, not silently accepted.
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: ['packages/*/tsconfig.json', 'services/*/tsconfig.json', 'apps/*/tsconfig.json'],
        }),
      ],
    },
    rules: SHARED_RULES,
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.config.{js,mjs,ts}', '**/eslint.config.js'],
    rules: { 'import-x/no-default-export': 'off' },
  },
  prettier,
);

/**
 * Relaxations for test files, appended AFTER the environment-specific rules.
 *
 * The coordinate rule must be off here: the tests that prove redaction works
 * have to pass a real coordinate into a logger and assert it does not come out
 * the other side. Placing this block last is load-bearing — a flat config's
 * later entry wins, so putting it only in `base` would be silently re-enabled
 * by the environment blocks below.
 */
const TEST_OVERRIDES = {
  files: [
    '**/*.test.{ts,tsx,js,jsx}',
    '**/*.spec.{ts,tsx,js,jsx}',
    '**/__tests__/**/*.{ts,tsx,js,jsx}',
    '**/tests/**/*.{ts,tsx,js,jsx}',
  ],
  rules: {
    'no-restricted-syntax': 'off',
    'no-console': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
};

/** Node / Lambda services and scripts. Bans unstructured console output. */
export const node = tseslint.config(
  ...base,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: { globals: NODE_GLOBALS },
    rules: {
      'no-restricted-syntax': ['error', ...coordinateLoggingRules, ...noConsoleLogRules],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  TEST_OVERRIDES,
);

/**
 * Command-line entry points, where writing to stdout IS the interface. The
 * coordinate rule stays on; only the console ban is lifted.
 */
export const cli = tseslint.config(...base, {
  files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
  languageOptions: { globals: NODE_GLOBALS },
  rules: {
    'no-restricted-syntax': ['error', ...coordinateLoggingRules],
    'no-console': 'off',
  },
});

/** Alias kept for readability at the service call-site. */
export const services = node;

/** React Native / Expo apps and the shared design system. */
export const reactNative = tseslint.config(
  ...base,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: REACT_NATIVE_GLOBALS,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-restricted-syntax': ['error', ...coordinateLoggingRules],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  TEST_OVERRIDES,
);

export default base;
