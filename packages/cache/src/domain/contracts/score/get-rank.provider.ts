import { type Either } from '@ruguin/utils'

import { type CacheConsistency } from '../../enums'
import { type CacheOperationError } from '../../errors'

export namespace GetRankProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    member: string
    consistency?: CacheConsistency
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ rank: number | null; total: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IGetRankProvider {
  getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output
}
