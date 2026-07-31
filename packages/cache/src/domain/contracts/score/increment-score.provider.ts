import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace IncrementScoreProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    by: number
    ttlInMs?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ score: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IIncrementScoreProvider {
  incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output
}
