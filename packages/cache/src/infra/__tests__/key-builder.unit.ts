import { describe, expect, it } from 'vitest'

import { InvalidCacheKeyError } from '../../domain/index.ts'
import { KeyBuilder } from '../key-builder.ts'

describe('KeyBuilder', () => {
  const builder = new KeyBuilder({ prefix: 'ruguin:iam' })

  it('assembles prefix, namespace, version and key', () => {
    const result = builder.build({ namespace: 'user', version: 7, key: '123' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.physicalKey).toBe('ruguin:iam:user:v7:123')
  })

  it('builds the version key for a namespace', () => {
    const result = builder.buildVersionKey({ namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.physicalKey).toBe('ruguin:iam:user:__version__')
  })

  it('builds a lock key that cannot collide with a value key', () => {
    const result = builder.buildLockKey({ namespace: 'user', key: '123' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.physicalKey).toBe('ruguin:iam:user:__lock__:123')
  })

  it.each([
    ['empty', ''],
    ['blank', ' '],
    ['with a space', 'a b'],
    ['with a newline', 'a\nb'],
    ['with a colon', 'a:b']
  ])('rejects a key that is %s', (_label, key) => {
    const result = builder.build({ namespace: 'user', version: 1, key })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(InvalidCacheKeyError)
    expect(result.value.message).toContain('key')
  })

  it('rejects an invalid namespace and names that field', () => {
    const result = builder.build({ namespace: 'bad namespace', version: 1, key: '123' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('namespace')
  })

  it('rejects a non-positive version and blames the version, not the namespace', () => {
    const result = builder.build({ namespace: 'user', version: 0, key: '123' })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('version')
    expect(result.value.message).not.toContain('namespace')
  })
})
