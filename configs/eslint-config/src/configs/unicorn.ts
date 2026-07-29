import { unicornPlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const unicorn = (overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/unicorn/rules',
    plugins: {
      unicorn: unicornPlugin
    },
    rules: {
      ...unicornPlugin.configs.recommended.rules,

      /*
       * Allow the conventional double-underscore test/mock directories that
       * Vitest/Jest use (e.g. src/__tests__/); the default rule flags them.
       */
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
          ignore: [/^__(?:tests|mocks|fixtures|snapshots)__$/u]
        }
      ],

      // Too opinionated
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/name-replacements': ['error', { replacements: { repository: false } }],
      'unicorn/no-null': 'off',
      'unicorn/consistent-class-member-order': 'off',

      ...overrides
    }
  }
]
