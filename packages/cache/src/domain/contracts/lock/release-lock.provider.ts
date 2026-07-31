import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotOwnedError } from '../../errors'

export namespace ReleaseLockProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; token: string }>

  export type OutputError = Readonly<CacheOperationError | LockNotOwnedError>
  export type OutputSuccess = Readonly<{ released: boolean }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IReleaseLockProvider {
  release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output
}
