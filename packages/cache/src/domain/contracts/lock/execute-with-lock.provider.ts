import { type Either } from '@ruguin/utils'

import { type CacheOperationError, type LockNotAcquiredError } from '../../errors'

import { type AcquireLockProviderDTO } from './acquire-lock.provider'

export namespace ExecuteWithLockProviderDTO {
  export type Input<T, E> = Readonly<{
    key: string
    namespace: string
    ttlInMs: number

    // Passed straight through to the driver; see AcquireLockProviderDTO.Wait for the semantics.
    wait?: AcquireLockProviderDTO.Wait
    task: () => Promise<Either<E, T>>
  }>

  export type OutputError<E> = Readonly<E | CacheOperationError | LockNotAcquiredError>
  export type OutputSuccess<T> = Readonly<{ value: T }>

  export type Output<T, E> = Promise<Either<OutputError<E>, OutputSuccess<T>>>
}

export interface IExecuteWithLockProvider {
  executeWithLock<T, E>(input: ExecuteWithLockProviderDTO.Input<T, E>): ExecuteWithLockProviderDTO.Output<T, E>
}
