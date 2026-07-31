import { type Either } from '@ruguin/utils'

import { type CacheConsistency, type CacheSource } from '../../enums'

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

  export type OutputError<E> = Readonly<E>
  export type OutputSuccess<T> = Readonly<{ value: T | null; source: CacheSource }>

  export type Output<T, E> = Promise<Either<OutputError<E>, OutputSuccess<T>>>
}

export interface IGetOrSetCacheProvider {
  getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E>
}
