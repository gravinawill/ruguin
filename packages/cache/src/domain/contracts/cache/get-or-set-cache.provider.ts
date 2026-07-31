import { type Either } from '@ruguin/utils'

import { type CacheConsistency, type CacheLockOutcome, type CacheSource } from '../../enums'

export namespace GetOrSetCacheProviderDTO {
  export type Input<T, E> = Readonly<{
    key: string
    namespace: string
    ttlInMs?: number
    negativeTtlInMs?: number
    consistency?: CacheConsistency
    forceRefresh?: boolean
    lock?: Readonly<{ enabled: boolean; waitTimeoutInMs?: number }>
    validate?: (value: unknown) => boolean
    loader: () => Promise<Either<E, T | null>>
  }>

  /*
   * Still bare `E`: getOrSet is fail-open by contract, and encoding that in the type is what
   * stops a cache outage from ever surfacing as a failure of the call. Observability about the
   * lock therefore rides on the success, never here.
   */
  export type OutputError<E> = Readonly<E>

  /*
   * `lockOutcome` is on every success, not just the locked ones. When it is NOT_ACQUIRED the
   * caller asked for stampede protection and the loader ran without it — otherwise
   * indistinguishable from a clean run, and now the common case for CACHE_DRIVER=noop, whose
   * lock refuses by design.
   */
  export type OutputSuccess<T> = Readonly<{ value: T | null; source: CacheSource; lockOutcome: CacheLockOutcome }>

  export type Output<T, E> = Promise<Either<OutputError<E>, OutputSuccess<T>>>
}

export interface IGetOrSetCacheProvider {
  getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E>
}
