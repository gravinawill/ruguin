import { failure, success } from '@ruguin/utils'

import {
  type AcquireLockProviderDTO,
  type ExtendLockProviderDTO,
  LockNotAcquiredError,
  LockNotOwnedError,
  type ReleaseLockProviderDTO
} from '../../../../domain'
import { type KeyBuilder } from '../../../key-builder'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { EXTEND_LOCK_SCRIPT, RELEASE_LOCK_SCRIPT } from '../scripts/lua-scripts'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

// Floor for a caller-supplied poll interval. See AcquireLockProviderDTO.Wait.
const MIN_POLL_INTERVAL_MS = 1

const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const isTruthyReply = (input: { value: unknown }): boolean => typeof input.value === 'number' && input.value > 0

/*
 * Locks never touch a replica, in either direction. Acquiring one off a node with replication
 * lag would rebuild the exact race the lock exists to close: two callers reading "free" from a
 * stale copy and both writing.
 */
export class LockOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keyBuilder: KeyBuilder

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keyBuilder: KeyBuilder
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keyBuilder = input.keyBuilder
  }

  public async acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ key: input.key, namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const lockKey: string = key.value.physicalKey
    const token: string = crypto.randomUUID()
    const ttlInMs: number = input.ttlInMs

    /*
     * The budget is anchored once, at entry, and spent against the clock. Turning it into
     * `ceil(timeout / poll)` attempts would overshoot by the cost of the attempts themselves —
     * and against a network driver each attempt is a round trip, so a caller asking for 3s would
     * wait longest exactly when the cache is degraded and the round trips are slowest.
     */
    const deadlineAt: number = Date.now() + (input.wait?.timeoutInMs ?? 0)
    const pollIntervalInMs: number = Math.max(MIN_POLL_INTERVAL_MS, input.wait?.pollIntervalInMs ?? 0)

    let attempts = 0

    for (;;) {
      attempts += 1

      const stored = await this.executor.run({
        command: () => connection.set(lockKey, token, 'PX', ttlInMs, 'NX'),
        operation: 'acquire'
      })
      if (stored.isFailure()) return failure(stored.value)
      if (stored.value === 'OK') return success({ expiresAt: new Date(Date.now() + ttlInMs), token })

      const remainingInMs: number = deadlineAt - Date.now()
      if (remainingInMs <= 0) break

      // Capped by whatever is left, so the last attempt lands on the deadline rather than past it.
      await sleep(Math.min(pollIntervalInMs, remainingInMs))
    }

    return failure(new LockNotAcquiredError({ attempts, lockKey }))
  }

  public async release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ key: input.key, namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const lockKey: string = key.value.physicalKey
    const token: string = input.token

    const released = await this.executor.run({
      command: () => connection.eval(RELEASE_LOCK_SCRIPT.source, RELEASE_LOCK_SCRIPT.numberOfKeys, lockKey, token),
      operation: 'release'
    })
    if (released.isFailure()) return failure(released.value)

    // Zero means the token no longer matches: the lock expired and someone else took it.
    if (!isTruthyReply({ value: released.value })) return failure(new LockNotOwnedError({ lockKey }))

    return success({ released: true })
  }

  public async extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    const key = this.keyBuilder.buildLockKey({ key: input.key, namespace: input.namespace })
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const lockKey: string = key.value.physicalKey
    const token: string = input.token
    const ttlInMs: number = input.ttlInMs

    const extended = await this.executor.run({
      command: () =>
        connection.eval(EXTEND_LOCK_SCRIPT.source, EXTEND_LOCK_SCRIPT.numberOfKeys, lockKey, token, ttlInMs),
      operation: 'extend'
    })
    if (extended.isFailure()) return failure(extended.value)

    if (!isTruthyReply({ value: extended.value })) return failure(new LockNotOwnedError({ lockKey }))

    return success({ expiresAt: new Date(Date.now() + ttlInMs) })
  }
}
