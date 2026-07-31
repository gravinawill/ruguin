import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/__tests__/**/*.unit.ts'],
          testTimeout: 5000
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/__tests__/**/*.int.ts'],
          testTimeout: 15_000
        }
      }
    ]
  }
})
