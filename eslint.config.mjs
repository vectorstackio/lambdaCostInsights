import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],

    languageOptions: {
      parser: tseslint.parser
    },

    rules: {
      'no-control-regex': 0,
      'no-prototype-builtins': 0,

      'no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true
        }
      ],

      indent: ['error', 2],
      'linebreak-style': ['error', 'unix'],
      quotes: ['error', 'single'],
      semi: ['error', 'never']
    }
  },

  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'dist/**',
    'next-env.d.ts'
  ])
])
