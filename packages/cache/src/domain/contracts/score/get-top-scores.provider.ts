import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace GetTopScoresProviderDTO {
  export type Entry = Readonly<{ member: string; score: number }>

  export type Input = Readonly<{
    key: string
    namespace: string
    limit: number
    offset?: number
    consistency?: CacheConsistency
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ entries: readonly Entry[] }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetTopScoresProvider {
  getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output
}
