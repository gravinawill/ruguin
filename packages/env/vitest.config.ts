import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.unit.ts'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    testTimeout: 5000,
    passWithNoTests: true
  }
})
