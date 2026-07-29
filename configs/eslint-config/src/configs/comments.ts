import { commentsPlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const comments = (overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/eslint-comments/rules',
    plugins: {
      '@eslint-community/eslint-comments': commentsPlugin
    },
    rules: {
      ...commentsPlugin.configs.recommended.rules,

      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      '@eslint-community/eslint-comments/no-restricted-disable': 'error',
      '@eslint-community/eslint-comments/no-use': ['error', { allow: ['eslint-disable-next-line'] }],

      ...overrides
    }
  }
]
