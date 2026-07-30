import { describe, expect, it } from 'vitest'

import { StatusError } from '../status-error.enum'

describe('StatusError', () => {
  it('exposes one member per HTTP-mappable error category', () => {
    expect(StatusError.INVALID_INPUT).toBe('INVALID_INPUT')
    expect(StatusError.UNAUTHORIZED).toBe('UNAUTHORIZED')
    expect(StatusError.FORBIDDEN).toBe('FORBIDDEN')
    expect(StatusError.NOT_FOUND).toBe('NOT_FOUND')
    expect(StatusError.CONFLICT).toBe('CONFLICT')
    expect(StatusError.UNPROCESSABLE).toBe('UNPROCESSABLE')
    expect(StatusError.TOO_MANY_REQUESTS).toBe('TOO_MANY_REQUESTS')
    expect(StatusError.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
  })
})
