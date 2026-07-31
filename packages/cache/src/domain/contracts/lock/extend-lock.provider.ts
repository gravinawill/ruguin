import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotOwnedError } from '../../errors'

export namespace ExtendLockProviderDTO {
  export type Input = Readonly<{ key: string; namespace: string; token: string; ttlInMs: number }>

  export type OutputError = Readonly<CacheOperationError | LockNotOwnedError>
  export type OutputSuccess = Readonly<{ expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IExtendLockProvider {
  extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output
}
