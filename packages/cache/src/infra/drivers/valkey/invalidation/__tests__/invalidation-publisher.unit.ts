import { describe, expect, it } from 'vitest'

import { decodeInvalidation, encodeInvalidation, invalidationChannelOf } from '../invalidation-publisher'

describe('invalidation payload', () => {
  it('namespaces the channel by prefix, so two services never cross-invalidate', () => {
    expect(invalidationChannelOf({ prefix: 'ruguin:iam' })).toBe('ruguin:iam:__invalidation__')
  })

  it('round-trips a message', () => {
    const encoded: string = encodeInvalidation({ namespace: 'user', version: 8 })

    expect(decodeInvalidation({ raw: encoded })).toEqual({ namespace: 'user', version: 8 })
  })

  /*
   * Anything can land on a Pub/Sub channel — another service, an operator with valkey-cli, an
   * older build. Every one of these has to be droppable without touching the memo, because a
   * half-applied message would move a version the server never reached.
   */
  it.each([
    ['not json at all', 'definitely not json'],
    ['a json scalar', '"user"'],
    ['null', 'null'],
    ['a missing namespace', '{"version":8}'],
    ['an empty namespace', '{"namespace":"","version":8}'],
    ['a missing version', '{"namespace":"user"}'],
    ['a non-numeric version', '{"namespace":"user","version":"8"}'],
    ['a fractional version', '{"namespace":"user","version":8.5}']
  ])('drops %s', (_name, raw) => {
    expect(decodeInvalidation({ raw })).toBeNull()
  })
})
