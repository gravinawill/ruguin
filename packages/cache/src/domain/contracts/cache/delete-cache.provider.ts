import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace DeleteCacheProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ existed: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IDeleteCacheProvider {
  delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output
}
