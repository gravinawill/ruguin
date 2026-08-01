import { type RedisOptions } from 'iovalkey'

import { type OnCacheError } from '../application/index.ts'
import { type CacheConsistency, type ISerializerStrategy } from '../domain/index.ts'
import {
  CounterOperations,
  HealthOperations,
  InvalidationPublisher,
  InvalidationSubscriber,
  type KeyBuilder,
  KeyValueOperations,
  LockOperations,
  type NamespaceConfig,
  NamespaceOperations,
  NamespaceVersionResolver,
  PhysicalKeyResolver,
  ScoreOperations,
  ValkeyCacheDriver,
  ValkeyCommandExecutor,
  ValkeyConnectionManager
} from '../infra/index.ts'

export type ValkeyDriverConfig = Readonly<{
  connectionOptions?: RedisOptions
  defaultConsistency: CacheConsistency
  defaultTtlInMs: number
  invalidationBroadcast: boolean
  jitterRatio: number
  keyBuilder: KeyBuilder
  masterUrl: string
  namespaces: NamespaceConfig
  namespaceVersionLocalTtlInMs: number
  onCacheError: OnCacheError
  operationTimeoutInMs: number
  prefix: string
  replicaUrls: readonly string[]
  replicationLagThresholdInBytes: number
  serializer: ISerializerStrategy
}>

/*
 * Wiring, kept out of CacheFactory because the Valkey family has eleven collaborators and the
 * other two families have one each. Assembling it inline would bury the driver *selection* — the
 * factory's actual job — under the construction of a single branch.
 */
export const createValkeyDriver = (input: ValkeyDriverConfig): ValkeyCacheDriver => {
  const connections = new ValkeyConnectionManager({
    masterUrl: input.masterUrl,
    replicaUrls: input.replicaUrls,
    withSubscriber: input.invalidationBroadcast,
    ...(input.connectionOptions !== undefined && { options: input.connectionOptions })
  })

  const executor = new ValkeyCommandExecutor({ timeoutInMs: input.operationTimeoutInMs })

  const publisher: InvalidationPublisher | null = input.invalidationBroadcast
    ? new InvalidationPublisher({
        connections,
        executor,
        onCacheError: input.onCacheError,
        prefix: input.prefix
      })
    : null

  const namespaces = new NamespaceOperations({ connections, executor, keyBuilder: input.keyBuilder, publisher })

  const versions = new NamespaceVersionResolver({
    defaultConsistency: input.defaultConsistency,
    localTtlInMs: input.namespaceVersionLocalTtlInMs,
    namespaces: input.namespaces,
    source: { fetchVersion: (lookup) => namespaces.fetchVersion(lookup) }
  })

  const keys = new PhysicalKeyResolver({ keyBuilder: input.keyBuilder, versions })

  return new ValkeyCacheDriver({
    connections,
    counters: new CounterOperations({ connections, executor, keys }),
    health: new HealthOperations({
      connections,
      executor,
      replicationLagThresholdInBytes: input.replicationLagThresholdInBytes
    }),
    keyValue: new KeyValueOperations({
      connections,
      defaultTtlInMs: input.defaultTtlInMs,
      executor,
      jitterRatio: input.jitterRatio,
      keyBuilder: input.keyBuilder,
      keys,
      prefix: input.prefix,
      serializer: input.serializer,
      versions
    }),
    locks: new LockOperations({ connections, executor, keyBuilder: input.keyBuilder }),
    namespaces,
    onCacheError: input.onCacheError,
    scores: new ScoreOperations({ connections, executor, keys }),
    subscriber: input.invalidationBroadcast
      ? new InvalidationSubscriber({
          connections,
          executor,
          onCacheError: input.onCacheError,
          prefix: input.prefix,
          versions
        })
      : null,
    versions
  })
}
