import { tailwindcssPlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const tailwindcss = (entryPoint: string, overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/tailwindcss/rules',
    plugins: {
      'better-tailwindcss': tailwindcssPlugin
    },
    rules: {
      'better-tailwindcss/enforce-consistent-class-order': 'error',
      'better-tailwindcss/enforce-consistent-important-position': 'error',
      'better-tailwindcss/enforce-consistent-variable-syntax': 'error',
      'better-tailwindcss/enforce-shorthand-classes': 'error',
      'better-tailwindcss/no-conflicting-classes': 'error',
      'better-tailwindcss/no-deprecated-classes': 'error',
      'better-tailwindcss/no-duplicate-classes': 'error',
      'better-tailwindcss/no-unnecessary-whitespace': 'error',
      'better-tailwindcss/no-unregistered-classes': 'error',

      ...overrides
    },
    settings: {
      'better-tailwindcss': {
        entryPoint
      }
    }
  }
]
