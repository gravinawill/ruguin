import { nodePlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const node = (overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/node/rules',
    plugins: {
      n: nodePlugin
    },
    rules: {
      'n/handle-callback-err': ['error', '^(err|error)$'],
      'n/no-deprecated-api': 'error',
      'n/no-exports-assign': 'error',
      'n/no-new-require': 'error',
      'n/no-path-concat': 'error',
      'n/prefer-promises/fs': 'error',
      'n/process-exit-as-throw': 'error',

      ...overrides
    }
  }
]
