import { failure, success } from '@ruguin/utils'

import {
  type ExecuteWithLockProviderDTO,
  type IAcquireLockProvider,
  type IExecuteWithLockProvider,
  type IReleaseLockProvider
} from '../domain'

export class ExecuteWithLockProvider implements IExecuteWithLockProvider {
  private readonly lockAcquirer: IAcquireLockProvider
  private readonly lockReleaser: IReleaseLockProvider
  private readonly onCacheError: (error: unknown) => void

  constructor(input: {
    lockAcquirer: IAcquireLockProvider
    lockReleaser: IReleaseLockProvider
    onCacheError: (error: unknown) => void
  }) {
    this.lockAcquirer = input.lockAcquirer
    this.lockReleaser = input.lockReleaser
    this.onCacheError = input.onCacheError
  }

  public async executeWithLock<T, E>(
    input: ExecuteWithLockProviderDTO.Input<T, E>
  ): ExecuteWithLockProviderDTO.Output<T, E> {
    const acquired = await this.lockAcquirer.acquire({
      key: input.key,
      namespace: input.namespace,
      ttlInMs: input.ttlInMs,
      ...(input.retry !== undefined && { retry: input.retry })
    })

    /*
     * No fail-open here: running the task without the lock would break the mutual
     * exclusion the caller explicitly asked for.
     */
    if (acquired.isFailure()) return failure(acquired.value)

    try {
      const executed = await input.task()
      if (executed.isFailure()) return failure(executed.value)

      return success({ value: executed.value })
    } finally {
      const released = await this.lockReleaser.release({
        key: input.key,
        namespace: input.namespace,
        token: acquired.value.token
      })

      // Reported, never thrown: a failed release must not overwrite the task's own result.
      if (released.isFailure()) this.onCacheError(released.value)
    }
  }
}
