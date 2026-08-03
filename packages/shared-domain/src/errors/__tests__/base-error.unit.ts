import { describe, expect, it } from 'vitest'

import { StatusError } from '../../enums/index.ts'
import { BaseError } from '../base-error.ts'

class StubError extends BaseError {
  readonly name = 'StubError'
  readonly status = StatusError.INTERNAL_ERROR

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- required to create public constructor for test stub
  constructor(input: { message: string; error?: unknown }) {
    super(input)
  }
}

describe('BaseError', () => {
  it('exposes message, name and status from the concrete subclass', () => {
    const error = new StubError({ message: 'something broke' })

    expect(error.message).toBe('something broke')
    expect(error.name).toBe('StubError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.error).toBeUndefined()
  })

  it('carries the original error when provided', () => {
    const original = new Error('root cause')
    const error = new StubError({ message: 'wrapped', error: original })

    expect(error.error).toBe(original)
  })
})
