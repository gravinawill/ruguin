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

      /*
       * `@eslint-react/naming-convention/filename` doesn't exist in the installed
       * @eslint-react/eslint-plugin@5.x — v5 flattened every sub-plugin (naming-convention,
       * hooks-extra, dom, web-api, ...) into the single `@eslint-react` namespace and this
       * particular rule wasn't carried over. Filename casing is already covered repo-wide by
       * `unicorn/filename-case` (see configs/unicorn.ts), so nothing is lost by dropping it.
       */

      // Unnecessary
      '@eslint-react/avoid-shorthand-boolean': 'off',
      '@eslint-react/avoid-shorthand-fragment': 'off',
      '@eslint-react/no-complex-conditional-rendering': 'off',
      '@eslint-react/no-array-index-key': 'off',

      ...overrides
    }
  }
]
