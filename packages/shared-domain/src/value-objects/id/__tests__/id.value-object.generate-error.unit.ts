import { describe, expect, it, vi } from 'vitest'

import { ID } from '../id.value-object.ts'

vi.mock('uuid', () => ({
  v7: () => {
    throw new Error('crypto unavailable')
  }
}))

describe('ID.generate', () => {
  it('returns a GenerateIDError when the underlying UUID generator throws', () => {
    const result = ID.generate({ modelName: 'Email' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('GenerateIDError')
      expect(result.value.message).toBe('Failed to generate ID for "Email"')
      expect((result.value.error as Error).message).toBe('crypto unavailable')
    }
  })
})
