import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import {
  type IAcquireLockProvider,
  type IReleaseLockProvider,
  LockNotAcquiredError,
  LockNotOwnedError
} from '../../domain'
import { ExecuteWithLockProvider } from '../execute-with-lock.provider'
import { type OnCacheError } from '../on-cache-error'

const grantingLock: IAcquireLockProvider = {
  acquire: () => {
    const expiresAt = new Date(Date.now() + 5000)

    return Promise.resolve(success({ token: 'token-1', expiresAt }))
  }
}

const busyLock: IAcquireLockProvider = {
  acquire: () => Promise.resolve(failure(new LockNotAcquiredError({ lockKey: 'job', attempts: 1 })))
}

const noop = (): void => undefined

const recordingReleaser = (): { releaser: IReleaseLockProvider; tokens: () => string[] } => {
  const tokens: string[] = []

  return {
    releaser: {
      release: (input) => {
        tokens.push(input.token)
        return Promise.resolve(success({ released: true }))
      }
    },
    tokens: () => tokens
  }
}

describe('ExecuteWithLockProvider', () => {
  it('runs the task under the lock and releases it', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: releaser,
      onCacheError: noop
    })

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: () => Promise.resolve(success('done'))
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('done')
    expect(tokens()).toEqual(['token-1'])
  })

  it('refuses to run the task when the lock is busy', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({ lockAcquirer: busyLock, lockReleaser: releaser, onCacheError: noop })
    const task = vi.fn((): Promise<Either<Error, string>> => Promise.resolve(success('should not run')))

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task
    })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBeInstanceOf(LockNotAcquiredError)
    expect(task).not.toHaveBeenCalled()
    expect(tokens()).toEqual([])
  })

  it('releases the lock when the task fails', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: releaser,
      onCacheError: noop
    })
    const boom = new Error('task blew up')

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: () => Promise.resolve(failure(boom))
    })

    expect(result.isFailure()).toBe(true)
    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value).toBe(boom)
    expect(tokens()).toEqual(['token-1'])
  })

  it('releases the lock when the task throws', async () => {
    const { releaser, tokens } = recordingReleaser()
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: releaser,
      onCacheError: noop
    })

    await expect(
      provider.executeWithLock<string, Error>({
        key: 'job',
        namespace: 'dispatch',
        ttlInMs: 5000,
        task: () => {
          throw new Error('unexpected')
        }
      })
    ).rejects.toThrow('unexpected')

    expect(tokens()).toEqual(['token-1'])
  })

  it('does not mask the task result when the release fails, and says which call failed', async () => {
    const brokenReleaser: IReleaseLockProvider = {
      release: () => Promise.resolve(failure(new LockNotOwnedError({ lockKey: 'job' })))
    }
    const reports: Array<Parameters<OnCacheError>[0]> = []
    const provider = new ExecuteWithLockProvider({
      lockAcquirer: grantingLock,
      lockReleaser: brokenReleaser,
      onCacheError: (report) => {
        reports.push(report)
      }
    })

    const result = await provider.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: () => Promise.resolve(success('done'))
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.value).toBe('done')
    expect(reports).toEqual([
      { operation: 'release', namespace: 'dispatch', key: 'job', error: expect.any(LockNotOwnedError) }
    ])
  })
})
