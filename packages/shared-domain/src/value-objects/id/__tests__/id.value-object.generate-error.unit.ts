import { describe, expect, it, vi } from 'vitest'

import { ID } from '../id.value-object.ts'

/*
 * Hoisted so each test can drive a different failure (Error vs. non-Error thrown value)
 * instead of the whole file being locked to one static throw.
 */
const { generateUuidV7 } = vi.hoisted(() => ({ generateUuidV7: vi.fn() }))

vi.mock('uuid', () => ({ v7: generateUuidV7 }))

describe('ID.generate', () => {
  it('returns a GenerateIDError naming the modelName owner when the underlying UUID generator throws', () => {
    generateUuidV7.mockImplementationOnce(() => {
      throw new Error('crypto unavailable')
    })

    const result = ID.generate({ modelName: 'Email' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('GenerateIDError')
      expect(result.value.message).toBe('Failed to generate ID for "Email"')
      expect((result.value.error as Error).message).toBe('crypto unavailable')
    }
  })

  it('returns a GenerateIDError naming the valueObjectName owner when the underlying UUID generator throws', () => {
    generateUuidV7.mockImplementationOnce(() => {
      throw new Error('crypto unavailable')
    })

    const result = ID.generate({ valueObjectName: 'ProjectID' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.message).toBe('Failed to generate ID for "ProjectID"')
    }
  })

  it('wraps a non-Error thrown value in an Error instead of surfacing it as-is', () => {
    const thrown: unknown = 'crypto module missing'
    generateUuidV7.mockImplementationOnce(() => {
      throw thrown
    })

    const result = ID.generate({ modelName: 'Email' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.error).toBeInstanceOf(Error)
      expect((result.value.error as Error).message).toBe('crypto module missing')
    }
  })
})
