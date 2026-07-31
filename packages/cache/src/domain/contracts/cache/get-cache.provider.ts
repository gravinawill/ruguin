import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError, type CacheSerializationError } from '../../errors'

export namespace GetCacheProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    consistency?: CacheConsistency
    validate?: (value: unknown) => boolean
  }>

  export type OutputError = Readonly<CacheOperationError | CacheSerializationError>
  export type OutputSuccess<T> = Readonly<{ found: boolean; value: T | null }>

  export type Output<T> = Promise<Either<OutputError, OutputSuccess<T>>>
}

export interface IGetCacheProvider {
  get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T>
}
