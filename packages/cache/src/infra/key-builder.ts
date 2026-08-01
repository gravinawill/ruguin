import { type Either, failure, success } from '@ruguin/utils'

import { InvalidCacheKeyError } from '../domain/index.ts'

type BuildOutput = Either<InvalidCacheKeyError, Readonly<{ physicalKey: string }>>

export class KeyBuilder {
  private static readonly FORBIDDEN: RegExp = /[\s:]/
  private static readonly VERSION_SUFFIX: string = '__version__'
  private static readonly LOCK_SEGMENT: string = '__lock__'

  private readonly prefix: string

  constructor(input: { prefix: string }) {
    this.prefix = input.prefix
  }

  public build(input: { namespace: string; version: number; key: string }): BuildOutput {
    const validated = this.validate({ namespace: input.namespace, key: input.key })
    if (validated.isFailure()) return failure(validated.value)

    if (!Number.isSafeInteger(input.version) || input.version < 1) {
      return failure(
        new InvalidCacheKeyError({
          field: 'version',
          value: String(input.version),
          reason: 'must be a positive integer'
        })
      )
    }

    return success({
      physicalKey: `${this.prefix}:${input.namespace}:v${input.version}:${input.key}`
    })
  }

  public buildVersionKey(input: { namespace: string }): BuildOutput {
    const validated = this.validateSegment({ field: 'namespace', value: input.namespace })
    if (validated.isFailure()) return failure(validated.value)

    return success({ physicalKey: `${this.prefix}:${input.namespace}:${KeyBuilder.VERSION_SUFFIX}` })
  }

  public buildLockKey(input: { namespace: string; key: string }): BuildOutput {
    const validated = this.validate({ namespace: input.namespace, key: input.key })
    if (validated.isFailure()) return failure(validated.value)

    return success({
      physicalKey: `${this.prefix}:${input.namespace}:${KeyBuilder.LOCK_SEGMENT}:${input.key}`
    })
  }

  private validate(input: { namespace: string; key: string }): Either<InvalidCacheKeyError, true> {
    const namespaceResult = this.validateSegment({ field: 'namespace', value: input.namespace })
    if (namespaceResult.isFailure()) return failure(namespaceResult.value)

    return this.validateSegment({ field: 'key', value: input.key })
  }

  private validateSegment(input: { field: 'key' | 'namespace'; value: string }): Either<InvalidCacheKeyError, true> {
    if (input.value.trim().length === 0) {
      return failure(new InvalidCacheKeyError({ field: input.field, value: input.value, reason: 'must not be blank' }))
    }

    if (KeyBuilder.FORBIDDEN.test(input.value)) {
      return failure(
        new InvalidCacheKeyError({
          field: input.field,
          value: input.value,
          reason: 'must not contain whitespace or ":"'
        })
      )
    }

    return success(true)
  }
}
