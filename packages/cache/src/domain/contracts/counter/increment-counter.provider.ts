import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace IncrementCounterProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    by?: number
    ttlInMs?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ value: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IIncrementCounterProvider {
  increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output
}
