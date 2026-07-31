import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace RemoveScoreProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; member: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ removed: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IRemoveScoreProvider {
  removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output
}
