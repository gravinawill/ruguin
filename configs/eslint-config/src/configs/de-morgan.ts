import { deMorganPlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const deMorgan = (overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/de-morgan/rules',
    plugins: {
      'de-morgan': deMorganPlugin
    },
    rules: {
      ...deMorganPlugin.configs.recommended.rules,

      ...overrides
    }
  }
]
