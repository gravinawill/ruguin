import { type Either, failure, success } from '@ruguin/utils'

import {
  type CacheConnectionError,
  CacheConsistency,
  type IResolveNamespaceVersionProvider,
  type ResolveNamespaceVersionProviderDTO
} from '../domain'

export type NamespaceVersionSource = Readonly<{
  fetchVersion: (input: {
    namespace: string
    consistency: CacheConsistency
  }) => Promise<Either<CacheConnectionError, Readonly<{ version: number }>>>
}>

export type NamespaceConfig = Readonly<Record<string, Readonly<{ consistency?: CacheConsistency }>>>

type MemoEntry = Readonly<{ version: number; expiresAt: number }>

const INITIAL_VERSION = 1

export class NamespaceVersionResolver implements IResolveNamespaceVersionProvider {
  private readonly memo: Map<string, MemoEntry> = new Map<string, MemoEntry>()
  private readonly source: NamespaceVersionSource
  private readonly defaultConsistency: CacheConsistency
  private readonly localTtlInMs: number
  private readonly namespaces: NamespaceConfig

  constructor(input: {
    source: NamespaceVersionSource
    defaultConsistency: CacheConsistency
    localTtlInMs: number
    namespaces: NamespaceConfig
  }) {
    this.source = input.source
    this.defaultConsistency = input.defaultConsistency
    this.localTtlInMs = input.localTtlInMs
    this.namespaces = input.namespaces
  }

  public async resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    const consistency: CacheConsistency = this.resolveConsistency(input)

    if (consistency === CacheConsistency.EVENTUAL) {
      const memoised: number | null = this.readMemo({ namespace: input.namespace })
      if (memoised !== null) return success({ version: memoised })
    }

    const fetched = await this.source.fetchVersion({ namespace: input.namespace, consistency })

    if (fetched.isFailure()) {
      /*
       * Strong mode asked for a guarantee, so a guess would be a lie: propagate and let
       * getOrSet fall through to the loader. Eventual mode degrades instead, per spec §4.4.
       */
      if (consistency === CacheConsistency.STRONG) return failure(fetched.value)

      return success({ version: this.memo.get(input.namespace)?.version ?? INITIAL_VERSION })
    }

    this.writeMemo({ namespace: input.namespace, version: fetched.value.version })

    return success({ version: fetched.value.version })
  }

  public applyBroadcast(input: { namespace: string; version: number }): void {
    const current: MemoEntry | undefined = this.memo.get(input.namespace)

    // Out-of-order or redelivered messages must never walk the version backwards.
    if (current !== undefined && current.version >= input.version) return

    this.writeMemo({ namespace: input.namespace, version: input.version })
  }

  public clearMemo(): void {
    this.memo.clear()
  }

  private resolveConsistency(input: ResolveNamespaceVersionProviderDTO.Input): CacheConsistency {
    return input.consistency ?? this.namespaces[input.namespace]?.consistency ?? this.defaultConsistency
  }

  private readMemo(input: { namespace: string }): number | null {
    if (this.localTtlInMs === 0) return null

    const entry: MemoEntry | undefined = this.memo.get(input.namespace)
    if (entry === undefined) return null
    if (Date.now() >= entry.expiresAt) return null

    return entry.version
  }

  private writeMemo(input: { namespace: string; version: number }): void {
    this.memo.set(input.namespace, {
      version: input.version,
      expiresAt: Date.now() + this.localTtlInMs
    })
  }
}
