import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotAcquiredError } from '../../errors'

export namespace AcquireLockProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    ttlInMs: number
    retry?: Readonly<{ attempts: number; delayInMs: number }>
  }>

  export type OutputError = Readonly<CacheOperationError | LockNotAcquiredError>
  export type OutputSuccess = Readonly<{ token: string; expiresAt: Date }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IAcquireLockProvider {
  acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output
}
