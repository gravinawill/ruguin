import { type ESLint } from 'eslint'

import { GLOB_SRC } from '../globs'
import { reactHooksPlugin, reactPlugin } from '../plugins'
import { type FlatConfig, type RuleOverrides } from '../types'

export const react = (overrides?: RuleOverrides): FlatConfig[] => [
  {
    name: 'ruguin/react/rules',
    files: [GLOB_SRC],
    plugins: {
      ...reactPlugin.configs.all.plugins,
      'react-hooks': reactHooksPlugin as unknown as ESLint.Plugin
    },
    rules: {
      ...reactPlugin.configs.all.rules,
      ...reactHooksPlugin.configs['recommended-latest'].rules,

      '@eslint-react/naming-convention/filename': [
        'error',
        {
          rule: 'kebab-case',
          excepts: ['index', '/^_/', String.raw`/^\$/`, '/^[0-9]+$/', String.raw`/^\[[^\]]+\]$/`]
        }
      ],

      // Unnecessary
      '@eslint-react/avoid-shorthand-boolean': 'off',
      '@eslint-react/avoid-shorthand-fragment': 'off',
      '@eslint-react/no-complex-conditional-rendering': 'off',
      '@eslint-react/no-array-index-key': 'off',

      ...overrides
    }
  }
]
