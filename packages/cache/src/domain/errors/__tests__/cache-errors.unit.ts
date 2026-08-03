import { StatusError } from '@ruguin/shared-domain'
import { describe, expect, it } from 'vitest'

import {
  CacheConnectionError,
  CacheNotInitializedError,
  CacheSerializationError,
  CacheTimeoutError,
  InvalidCacheKeyError,
  LockNotAcquiredError,
  LockNotOwnedError
} from '../index.ts'

describe('cache errors', () => {
  it('reports a connection failure as internal and keeps the original cause', () => {
    const cause = new Error('ECONNREFUSED')
    const error = new CacheConnectionError({ operation: 'get', error: cause })

    expect(error.name).toBe('CacheConnectionError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.message).toContain('get')
    expect(error.error).toBe(cause)
  })

  it('states the exceeded budget on a timeout', () => {
    const error = new CacheTimeoutError({ operation: 'set', timeoutInMs: 500 })

    expect(error.name).toBe('CacheTimeoutError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
    expect(error.message).toContain('500')
  })

  it('reports a serialization failure as internal', () => {
    const error = new CacheSerializationError({ operation: 'set' })

    expect(error.name).toBe('CacheSerializationError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
  })

  it('reports use before connect as internal', () => {
    const error = new CacheNotInitializedError({ operation: 'get' })

    expect(error.name).toBe('CacheNotInitializedError')
    expect(error.status).toBe(StatusError.INTERNAL_ERROR)
  })

  it('classifies an invalid key as bad input and names the offending field', () => {
    const error = new InvalidCacheKeyError({ field: 'namespace', value: 'has space', reason: 'contains whitespace' })

    expect(error.name).toBe('InvalidCacheKeyError')
    expect(error.status).toBe(StatusError.INVALID_INPUT)
    expect(error.message).toContain('namespace')
    expect(error.message).toContain('contains whitespace')
  })

  it('classifies a busy lock as a conflict', () => {
    const error = new LockNotAcquiredError({ lockKey: 'user:123', attempts: 3 })

    expect(error.name).toBe('LockNotAcquiredError')
    expect(error.status).toBe(StatusError.CONFLICT)
    expect(error.message).toContain('after 3 attempt')
  })

  it('classifies releasing a lock you no longer own as a conflict', () => {
    const error = new LockNotOwnedError({ lockKey: 'user:123' })

    expect(error.name).toBe('LockNotOwnedError')
    expect(error.status).toBe(StatusError.CONFLICT)
  })
})
