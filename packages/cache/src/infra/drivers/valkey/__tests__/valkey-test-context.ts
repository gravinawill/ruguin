import { type OnCacheError } from '../../../../application/index.ts'
import { CacheConsistency, CacheDriver, type ICacheProvider } from '../../../../domain/index.ts'
import { CacheFactory } from '../../../../factory/index.ts'
import { type NamespaceConfig } from '../../../namespace-version.resolver.ts'

export const MASTER_URL: string = process.env.CACHE_TEST_MASTER_URL ?? 'redis://localhost:6379'
export const REPLICA_URL: string = process.env.CACHE_TEST_REPLICA_URL ?? 'redis://localhost:6380'

export type TestCache = Readonly<{ errors: unknown[]; provider: ICacheProvider }>

/*
 * A fresh prefix per file, so a run that dies half way never leaves keys that make the next run
 * pass — or fail — for reasons that have nothing to do with the code. Nothing in this package
 * can SCAN the keyspace, so leftovers are invisible rather than harmful, and they expire anyway.
 */
export const uniquePrefix = (input: { label: string }): string =>
  `ruguin-test:${input.label}:${crypto.randomUUID().slice(0, 8)}`

export const createValkeyCache = (input: {
  invalidationBroadcast?: boolean
  namespaces?: NamespaceConfig
  namespaceVersionLocalTtlInMs?: number
  prefix: string
  replicaUrls?: readonly string[]
}): TestCache => {
  const errors: unknown[] = []
  const onCacheError: OnCacheError = (report) => {
    errors.push(report)
  }

  const created = CacheFactory.create({
    /*
     * Far above anything a green run produces: the breaker is unit-tested on its own, and letting
     * it trip here would turn one slow command into a cascade of unrelated assertion failures.
     */
    breaker: { failureThreshold: 1000, resetTimeoutInMs: 1000 },
    defaultConsistency: CacheConsistency.EVENTUAL,
    defaultTtlInMs: 60_000,
    driver: CacheDriver.VALKEY,
    invalidationBroadcast: input.invalidationBroadcast ?? false,
    // Off, so a written TTL is exactly the TTL the assertion expects.
    jitterRatio: 0,
    lockTtlInMs: 5000,
    masterUrl: MASTER_URL,
    namespaces: input.namespaces ?? {},
    namespaceVersionLocalTtlInMs: input.namespaceVersionLocalTtlInMs ?? 5000,
    negativeTtlInMs: 30_000,
    observability: false,
    onCacheError,
    operationTimeoutInMs: 2000,
    prefix: input.prefix,
    replicaUrls: input.replicaUrls ?? [],
    replicationLagThresholdInBytes: 1_048_576
  })

  if (created.isFailure()) throw new Error(created.value.message)

  return { errors, provider: created.value }
}

export const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
