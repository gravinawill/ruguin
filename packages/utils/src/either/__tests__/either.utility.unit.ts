import { describe, expect, it } from 'vitest'

import { failure, success } from '../either.utility'

describe('Either', () => {
  it('creates a Success that narrows via isSuccess/isFailure', () => {
    const result = success<Error, number>(42)

    expect(result.isSuccess()).toBe(true)
    expect(result.isFailure()).toBe(false)

    if (result.isSuccess()) {
      expect(result.value).toBe(42)
    }
  })

  it('creates a Failure that narrows via isSuccess/isFailure', () => {
    const error = new Error('boom')
    const result = failure<Error, number>(error)

    expect(result.isFailure()).toBe(true)
    expect(result.isSuccess()).toBe(false)

    if (result.isFailure()) {
      expect(result.value).toBe(error)
    }
  })
})
