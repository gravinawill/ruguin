import parser from '@typescript-eslint/parser'

import { GLOB_TS, GLOB_TSX } from '../globs'
import { typescriptPlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const typescript = (tsconfigRootDirectory: string = process.cwd(), overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/typescript/setup',
    files: [GLOB_TS, GLOB_TSX],
    languageOptions: {
      parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: tsconfigRootDirectory
      },
      sourceType: 'module'
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin
    }
  },
  {
    name: 'ruguin/typescript/rules',
    files: [GLOB_TS, GLOB_TSX],
    rules: {
      ...typescriptPlugin.configs['eslint-recommended'].overrides[0].rules,
      ...typescriptPlugin.configs['strict-type-checked'].rules,
      ...typescriptPlugin.configs['stylistic-type-checked'].rules,

      '@typescript-eslint/no-unsafe-call': 'off',

      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/no-invalid-this': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports'
        }
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],

      // Too opinionated
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',

      '@typescript-eslint/consistent-type-definitions': 'off',

      ...overrides
    }
  }
]
