import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type CacheSerializationError } from '../../errors/index.ts'

export namespace SetIfNotExistsCacheProviderDTO {
  export type Input<T> = Readonly<{
    key: string
    namespace: string
    value: T
    ttlInMs: number
  }>

  export type OutputError = Readonly<CacheOperationError | CacheSerializationError>
  export type OutputSuccess = Readonly<{ stored: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ISetIfNotExistsCacheProvider {
  setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output
}
