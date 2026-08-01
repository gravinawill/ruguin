import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type CacheSerializationError } from '../../errors/index.ts'

export namespace SetCacheProviderDTO {
  export type Input<T> = Readonly<{
    key: string
    namespace: string
    value: T
    ttlInMs?: number
    applyJitter?: boolean
  }>

  export type OutputError = Readonly<CacheOperationError | CacheSerializationError>
  export type OutputSuccess = Readonly<{ expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ISetCacheProvider {
  set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output
}
