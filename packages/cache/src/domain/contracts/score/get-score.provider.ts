import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace GetScoreProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    consistency?: CacheConsistency
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ score: number | null }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetScoreProvider {
  getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output
}
