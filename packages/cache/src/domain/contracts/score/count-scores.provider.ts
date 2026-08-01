import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums/index.ts'
import { type CacheOperationError } from '../../errors/index.ts'

export namespace CountScoresProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; consistency?: CacheConsistency }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ total: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ICountScoresProvider {
  countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output
}
