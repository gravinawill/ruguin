import { type Either, failure, success } from '@ruguin/utils'

import {
  CacheConsistency,
  type CacheOperationError,
  type InvalidateNamespaceProviderDTO
} from '../../../../domain/index.ts'
import { type KeyBuilder } from '../../../key-builder.ts'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager.ts'
import { type InvalidationPublisher } from '../invalidation/invalidation-publisher.ts'
import { BUMP_NAMESPACE_VERSION_SCRIPT } from '../scripts/lua-scripts.ts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor.ts'

const INITIAL_VERSION = 1

type FetchVersionOutput = Promise<Either<CacheOperationError, Readonly<{ version: number }>>>

/*
 * EVAL answers `unknown` and GET answers a string, so both shapes land here. An absent or
 * unreadable version means 1 — the same default the read script encodes — rather than 0, which
 * KeyBuilder would reject and turn a missing version key into a hard failure on every read.
 */
const toVersion = (input: { raw: unknown }): number => {
  if (typeof input.raw === 'number') {
    return Number.isSafeInteger(input.raw) && input.raw >= INITIAL_VERSION ? input.raw : INITIAL_VERSION
  }

  if (typeof input.raw !== 'string') return INITIAL_VERSION

  const parsed = Number(input.raw)

  return Number.isSafeInteger(parsed) && parsed >= INITIAL_VERSION ? parsed : INITIAL_VERSION
}

export class NamespaceOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keyBuilder: KeyBuilder
  private readonly publisher: InvalidationPublisher | null

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keyBuilder: KeyBuilder
    publisher: InvalidationPublisher | null
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keyBuilder = input.keyBuilder
    this.publisher = input.publisher
  }

  public async fetchVersion(input: { consistency: CacheConsistency; namespace: string }): FetchVersionOutput {
    const key = this.keyBuilder.buildVersionKey({ namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    /*
     * Strong mode reads the master. The INCR lands there, so a replica that has not replayed it
     * yet would answer with precisely the version the caller paid to bypass.
     */
    const client = input.consistency === CacheConsistency.STRONG ? this.connections.master() : this.connections.reader()
    if (client.isFailure()) return failure(client.value)

    const versionKey: string = key.value.physicalKey
    const connection = client.value

    const raw = await this.executor.run({
      command: () => connection.get(versionKey),
      operation: 'resolveNamespaceVersion'
    })
    if (raw.isFailure()) return failure(raw.value)

    return success({ version: toVersion({ raw: raw.value }) })
  }

  public async invalidate(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    const key = this.keyBuilder.buildVersionKey({ namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const versionKey: string = key.value.physicalKey
    const connection = master.value

    const bumped = await this.executor.run({
      command: () =>
        connection.eval(BUMP_NAMESPACE_VERSION_SCRIPT.source, BUMP_NAMESPACE_VERSION_SCRIPT.numberOfKeys, versionKey),
      operation: 'invalidateNamespace'
    })
    if (bumped.isFailure()) return failure(bumped.value)

    const version: number = toVersion({ raw: bumped.value })

    /*
     * Published after the bump, never before. A subscriber that memoised the new version while
     * the write was still in flight would build keys under a version the server had not reached,
     * and every read in that gap would miss against a key nobody had written yet.
     */
    if (this.publisher !== null) await this.publisher.publish({ namespace: input.namespace, version })

    return success({ version })
  }
}
