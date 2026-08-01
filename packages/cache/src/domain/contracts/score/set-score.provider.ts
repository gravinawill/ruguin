import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors/index.ts'

export namespace SetScoreProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    score: number
    ttlInMs?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ created: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface ISetScoreProvider {
  setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output
}
