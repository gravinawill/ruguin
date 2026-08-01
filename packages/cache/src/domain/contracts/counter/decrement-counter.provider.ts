import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors/index.ts'

export namespace DecrementCounterProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    by?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ value: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IDecrementCounterProvider {
  decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output
}
