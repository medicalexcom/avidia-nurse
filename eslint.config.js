const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-config-prettier');

module.exports = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/web-build/**',
      // Deno edge functions use URL imports and Deno globals; they are
      // typechecked/deployed via the Supabase CLI, not the Node toolchain.
      'supabase/functions/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Not needed with the automatic JSX runtime used by Expo/React 19.
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      globals: { require: 'readonly', module: 'writable', process: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Node ES-module scripts (tooling that runs outside the app bundle).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        // Blob is a Node 18+ global (used to upload test objects in authz-check).
        Blob: 'readonly',
      },
    },
  },
  {
    // Jest setup files run inside the Jest runtime.
    files: ['**/jest.setup.js'],
    languageOptions: {
      globals: { jest: 'readonly' },
    },
  },
  prettier
);
