import gitignorePlugin from 'eslint-config-flat-gitignore'

import { type FlatConfig } from '../types'

export const gitignore = (): FlatConfig[] => [
  gitignorePlugin({
    name: 'ruguin/gitignore'
  })
]
