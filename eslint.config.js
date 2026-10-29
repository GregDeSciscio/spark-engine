import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  performance: 'readonly',
  fetch: 'readonly',
  URLSearchParams: 'readonly',
  window: 'readonly',
  document: 'readonly',
};

export default tseslint.config(
  {
    // apps/*/public/libs holds vendored runtime files copied by the asset pipeline (Basis transcoder).
    ignores: ['**/dist/**', '**/node_modules/**', '**/out/**', 'tests/visual/**', 'tests/perf/**', 'apps/*/public/libs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the engine Random class; Math.random() breaks determinism.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    // ADR-002 / ADR-010: Rapier stays behind the physics module's handles.
    files: ['**/*.ts', '**/*.mjs', '**/*.js'],
    ignores: ['packages/engine/src/physics/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // @dimforge/rapier3d-compat and any other Rapier build.
          patterns: [
            {
              group: ['@dimforge/*'],
              message: 'Only packages/engine/src/physics imports Rapier. Use physics.bodies / physics.joints / the queries (ADR-010).',
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-011: the strain worker bundles destruction/core and its runner and nothing else, so no three,
    // no Rapier, no engine barrel. The core imports only itself.
    files: ['packages/engine/src/destruction/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^(?!\\./)', message: 'destruction/core is engine-agnostic: it imports only its own files (ADR-011).' }] },
      ],
    },
  },
  {
    files: ['packages/engine/src/destruction/strain/StrainRunner.ts', 'packages/engine/src/destruction/strain/strain.worker.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\./StrainRunner$|\\.\\./core/)',
              message: 'The strain worker imports only destruction/core and StrainRunner: no three, Rapier or engine barrel in its bundle (ADR-011).',
            },
          ],
        },
      ],
    },
  },
);
