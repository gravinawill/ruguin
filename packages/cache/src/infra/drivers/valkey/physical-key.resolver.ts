import { type Either, failure, success } from '@ruguin/utils'

import { type CacheConsistency, type CacheOperationError } from '../../../domain/index.ts'
import { type KeyBuilder } from '../../key-builder.ts'
import { type NamespaceVersionResolver } from '../../namespace-version.resolver.ts'

type PhysicalKeyOutput = Promise<Either<CacheOperationError, string>>

/*
 * Every namespaced command needs the same two steps — resolve the namespace version, then fold
 * it into the physical key — and getting the order or the failure handling wrong in one of the
 * fifteen call sites is the kind of bug that only shows up as a permanent miss on one operation.
 */
export class PhysicalKeyResolver {
  private readonly keyBuilder: KeyBuilder
  private readonly versions: NamespaceVersionResolver

  constructor(input: { keyBuilder: KeyBuilder; versions: NamespaceVersionResolver }) {
    this.keyBuilder = input.keyBuilder
    this.versions = input.versions
  }

  public consistencyFor(input: { consistency?: CacheConsistency; namespace: string }): CacheConsistency {
    return this.versions.effectiveConsistency(input)
  }

  public async physicalKey(input: {
    consistency?: CacheConsistency
    key: string
    namespace: string
  }): PhysicalKeyOutput {
    const version = await this.versions.resolveNamespaceVersion(input)
    if (version.isFailure()) return failure(version.value)

    const built = this.keyBuilder.build({
      key: input.key,
      namespace: input.namespace,
      version: version.value.version
    })
    if (built.isFailure()) return failure(built.value)

    return success(built.value.physicalKey)
  }
}
