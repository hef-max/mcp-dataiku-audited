import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', DOMException: 'readonly' } },
    rules: {
      // Existing generic DSS endpoints have intentionally untyped response bodies.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-case-declarations': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
