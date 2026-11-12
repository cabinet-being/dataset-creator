import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.claude/**',
      '.codex/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // 21 existing warnings; "fixing" deps would change effect behavior, so the rule is off.
      'react-hooks/exhaustive-deps': 'off',
      // Leading underscore marks intentionally unused destructured/parameter names.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
      }],
      // Few deliberate any usages at untyped boundaries; not worth churn.
      '@typescript-eslint/no-explicit-any': 'off',
      // `{}` is used as a loose placeholder type in legacy project manifest typing.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    rules: {
      // Best-effort localStorage/handle calls intentionally swallow errors in catch blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Filename sanitizers intentionally match control characters.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/*-browser.tsx', 'tests/*-checks.tsx'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['tests/*.mjs', 'scripts/**', '*.config.*', 'tests/e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
);
