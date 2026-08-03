import { describe, expect, it } from 'vitest'

import { StatusError } from '../../../../enums/index.ts'
import { GenerateIDError } from '../generate-id.error.ts'

describe('GenerateIDError', () => {
  it('builds the message from a modelName owner and carries the original error', () => {
    const original = new Error('crypto unavailable')
    const error = new GenerateIDError({ modelName: 'Email', error: original })

    expect(error.message).toBe('Failed to generate ID for "Email"')
    expect(error.name).toBe('GenerateIDError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.error).toBe(original)
  })

  it('builds the message from a valueObjectName owner', () => {
    const original = new Error('crypto unavailable')
    const error = new GenerateIDError({ valueObjectName: 'ID', error: original })

    expect(error.message).toBe('Failed to generate ID for "ID"')
  })
})
