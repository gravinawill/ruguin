import { describe, expect, it } from 'vitest'

import { CacheSerializationError } from '../../../domain'
import { JsonSerializerStrategy } from '../json-serializer.strategy'

describe('JsonSerializerStrategy', () => {
  const serializer = new JsonSerializerStrategy()

  it('round-trips an object', () => {
    const serialized = serializer.serialize({ value: { id: '1', tags: ['a'] } })

    if (serialized.isFailure()) throw new Error('expected success')

    const deserialized = serializer.deserialize<{ id: string; tags: string[] }>({
      raw: serialized.value.serialized
    })

    if (deserialized.isFailure()) throw new Error('expected success')
    expect(deserialized.value.value).toEqual({ id: '1', tags: ['a'] })
  })

  it('round-trips null without confusing it with a failure', () => {
    const serialized = serializer.serialize({ value: null })

    if (serialized.isFailure()) throw new Error('expected success')
    expect(serialized.value.serialized).toBe('null')

    const deserialized = serializer.deserialize<null>({ raw: 'null' })

    if (deserialized.isFailure()) throw new Error('expected success')
    expect(deserialized.value.value).toBeNull()
  })

  it('fails on a circular structure instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    const result = serializer.serialize({ value: circular })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(CacheSerializationError)
  })

  it('fails on malformed json instead of throwing', () => {
    const result = serializer.deserialize<unknown>({ raw: '{not json' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(CacheSerializationError)
  })

  it('fails when the value is undefined, which JSON cannot represent', () => {
    const result = serializer.serialize({ value: undefined })

    expect(result.isFailure()).toBe(true)
  })
})
