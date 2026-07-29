import { type FlatConfig } from '../types'

export const ignores = (userIgnores: string[] = []): FlatConfig[] => [
  {
    name: 'ruguin/ignores',
    ignores: [...userIgnores]
  }
]
