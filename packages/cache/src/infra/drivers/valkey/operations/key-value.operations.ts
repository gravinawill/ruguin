import { type Either, failure, success } from '@ruguin/utils'

import {
  CacheConsistency,
  type DeleteCacheProviderDTO,
  type GetCacheProviderDTO,
  type ISerializerStrategy,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO
} from '../../../../domain/index.ts'
import { applyTtlJitter } from '../../../apply-ttl-jitter.ts'
import { type KeyBuilder } from '../../../key-builder.ts'
import { type NamespaceVersionResolver } from '../../../namespace-version.resolver.ts'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager.ts'
import { type PhysicalKeyResolver } from '../physical-key.resolver.ts'
import { GET_WITH_NAMESPACE_VERSION_SCRIPT } from '../scripts/lua-scripts.ts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor.ts'

type ReadOutput<T> = Either<GetCacheProviderDTO.OutputError, GetCacheProviderDTO.OutputSuccess<T>>

const MISS = { found: false, value: null } as const

const toStringArray = (input: { value: unknown }): readonly string[] => {
  if (!Array.isArray(input.value)) return []

  const entries: readonly unknown[] = input.value

  return entries.filter((entry: unknown): entry is string => typeof entry === 'string')
}

export class KeyValueOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly defaultTtlInMs: number
  private readonly executor: ValkeyCommandExecutor
  private readonly jitterRatio: number
  private readonly keyBuilder: KeyBuilder
  private readonly keys: PhysicalKeyResolver
  private readonly prefix: string
  private readonly serializer: ISerializerStrategy
  private readonly versions: NamespaceVersionResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    defaultTtlInMs: number
    executor: ValkeyCommandExecutor
    jitterRatio: number
    keyBuilder: KeyBuilder
    keys: PhysicalKeyResolver
    prefix: string
    serializer: ISerializerStrategy
    versions: NamespaceVersionResolver
  }) {
    this.connections = input.connections
    this.defaultTtlInMs = input.defaultTtlInMs
    this.executor = input.executor
    this.jitterRatio = input.jitterRatio
    this.keyBuilder = input.keyBuilder
    this.keys = input.keys
    this.prefix = input.prefix
    this.serializer = input.serializer
    this.versions = input.versions
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const consistency: CacheConsistency = this.keys.consistencyFor(input)

    return consistency === CacheConsistency.STRONG ? this.getStrong<T>(input) : this.getEventual<T>(input)
  }

  public async set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return failure(serialized.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const payload: string = serialized.value.serialized
    const ttlInMs: number = applyTtlJitter({
      applyJitter: input.applyJitter,
      defaultTtlInMs: this.defaultTtlInMs,
      jitterRatio: this.jitterRatio,
      ttlInMs: input.ttlInMs
    })

    const stored = await this.executor.run({
      command: () => connection.set(physicalKey, payload, 'PX', ttlInMs),
      operation: 'set'
    })
    if (stored.isFailure()) return failure(stored.value)

    return success({ expiresAt: new Date(Date.now() + ttlInMs) })
  }

  public async delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value

    const removed = await this.executor.run({
      command: () => connection.del(physicalKey),
      operation: 'delete'
    })
    if (removed.isFailure()) return failure(removed.value)

    return success({ existed: removed.value > 0 })
  }

  public async setIfNotExists<T>(
    input: SetIfNotExistsCacheProviderDTO.Input<T>
  ): SetIfNotExistsCacheProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const serialized = this.serializer.serialize({ value: input.value })
    if (serialized.isFailure()) return failure(serialized.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const payload: string = serialized.value.serialized
    const ttlInMs: number = input.ttlInMs

    const stored = await this.executor.run({
      command: () => connection.set(physicalKey, payload, 'PX', ttlInMs, 'NX'),
      operation: 'setIfNotExists'
    })
    if (stored.isFailure()) return failure(stored.value)

    // A null reply is SET NX declining because the key was there — idempotency, not a failure.
    return success({ stored: stored.value === 'OK' })
  }

  private async getEventual<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const key = await this.keys.physicalKey({ ...input, consistency: CacheConsistency.EVENTUAL })
    if (key.isFailure()) return failure(key.value)

    const reader = this.connections.reader()
    if (reader.isFailure()) return failure(reader.value)

    const connection = reader.value
    const physicalKey: string = key.value

    const raw = await this.executor.run({
      command: () => connection.get(physicalKey),
      operation: 'get'
    })
    if (raw.isFailure()) return failure(raw.value)
    if (raw.value === null) return success(MISS)

    return this.decode<T>({ raw: raw.value, ...(input.validate !== undefined && { validate: input.validate }) })
  }

  private async getStrong<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    const versionKey = this.keyBuilder.buildVersionKey({ namespace: input.namespace })
    if (versionKey.isFailure()) return failure(versionKey.value)

    /*
     * The script assembles the physical key server-side, so nothing here would otherwise
     * validate the caller's key. Building one under a throwaway version and discarding it keeps
     * `InvalidCacheKeyError` coming from the same place in both modes, instead of letting a key
     * with a colon in it reach Valkey and silently address a different slot.
     */
    const validated = this.keyBuilder.build({ key: input.key, namespace: input.namespace, version: 1 })
    if (validated.isFailure()) return failure(validated.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const namespacePrefix = `${this.prefix}:${input.namespace}`
    const physicalVersionKey: string = versionKey.value.physicalKey
    const logicalKey: string = input.key

    const replied = await this.executor.run({
      command: () =>
        connection.eval_ro(
          GET_WITH_NAMESPACE_VERSION_SCRIPT.source,
          GET_WITH_NAMESPACE_VERSION_SCRIPT.numberOfKeys,
          physicalVersionKey,
          namespacePrefix,
          logicalKey
        ),
      operation: 'get'
    })
    if (replied.isFailure()) return failure(replied.value)

    const reply: readonly string[] = toStringArray({ value: replied.value })
    this.refreshMemo({ namespace: input.namespace, raw: reply[0] })

    const raw: string | undefined = reply[1]
    if (raw === undefined) return success(MISS)

    return this.decode<T>({ raw, ...(input.validate !== undefined && { validate: input.validate }) })
  }

  /*
   * A strong read just came back from the master carrying a version nobody else has yet. Handing
   * it to the memo is free — the round trip is already paid for — and every eventual read that
   * follows skips the hop it would otherwise take to learn the same number.
   */
  private refreshMemo(input: { namespace: string; raw: string | undefined }): void {
    if (input.raw === undefined) return

    const version = Number(input.raw)
    if (!Number.isSafeInteger(version) || version < 1) return

    this.versions.applyBroadcast({ namespace: input.namespace, version })
  }

  /*
   * A corrupt payload is a miss, not an outage: the loader refills the key and the next write
   * overwrites it. Unlike the memory driver this does not delete the entry — a read path that
   * issues a write would need the master, which is the one connection eventual reads exist to
   * stay off.
   */
  private decode<T>(input: { raw: string; validate?: (value: unknown) => boolean }): ReadOutput<T> {
    const deserialized = this.serializer.deserialize<T>({ raw: input.raw })
    if (deserialized.isFailure()) return success(MISS)

    if (input.validate !== undefined && !input.validate(deserialized.value.value)) return success(MISS)

    return success({ found: true, value: deserialized.value.value })
  }
}
