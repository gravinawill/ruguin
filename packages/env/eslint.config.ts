import { defineConfig } from '@ruguin/eslint-config'

export default defineConfig({
  overrides: {
    unicorn: {
      'unicorn/name-replacements': ['error', { replacements: { docs: false, repository: false } }]
    }
  }
})
