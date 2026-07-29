import { nextPlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const nextjs = (overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/nextjs/rules',
    plugins: {
      '@next/next': nextPlugin
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,

      ...overrides
    }
  }
]
