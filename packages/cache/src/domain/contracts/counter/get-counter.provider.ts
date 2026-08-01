import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors/index.ts'

export namespace GetCounterProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ value: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetCounterProvider {
  getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output
}
