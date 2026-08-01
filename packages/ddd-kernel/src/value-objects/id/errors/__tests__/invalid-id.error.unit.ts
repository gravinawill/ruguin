import { describe, expect, it } from 'vitest'

import { StatusError } from '../../../../enums/index.ts'
import { InvalidIDError } from '../invalid-id.error.ts'

describe('InvalidIDError', () => {
  it('builds the message from a modelName owner', () => {
    const error = new InvalidIDError({ id: 'not-a-uuid', modelName: 'Email' })

    expect(error.message).toBe('Invalid ID "not-a-uuid" for "Email"')
    expect(error.name).toBe('InvalidIDError')
    expect(error.status).toBe(StatusError.INVALID_INPUT)
  })

  it('builds the message from a valueObjectName owner', () => {
    const error = new InvalidIDError({ id: 'not-a-uuid', valueObjectName: 'ID' })

    expect(error.message).toBe('Invalid ID "not-a-uuid" for "ID"')
  })
})
