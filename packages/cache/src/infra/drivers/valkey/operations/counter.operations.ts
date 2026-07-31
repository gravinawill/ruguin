import { failure, success } from '@ruguin/utils'

import {
  type DecrementCounterProviderDTO,
  type GetCounterProviderDTO,
  type IncrementCounterProviderDTO
} from '../../../../domain'
import { type ValkeyConnectionManager } from '../connection/valkey-connection.manager'
import { type PhysicalKeyResolver } from '../physical-key.resolver'
import { type ValkeyCommandExecutor } from '../valkey-command.executor'

/*
 * Counters go to the master on reads too, unlike `get`. The use case is rate limiting, and a
 * replica running behind answers with a count lower than the truth — which lets traffic through
 * above the limit. A stale cached value costs a miss; a stale counter costs the guarantee.
 */
export class CounterOperations {
  private readonly connections: ValkeyConnectionManager
  private readonly executor: ValkeyCommandExecutor
  private readonly keys: PhysicalKeyResolver

  constructor(input: {
    connections: ValkeyConnectionManager
    executor: ValkeyCommandExecutor
    keys: PhysicalKeyResolver
  }) {
    this.connections = input.connections
    this.executor = input.executor
    this.keys = input.keys
  }

  public async increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const by: number = input.by ?? 1

    const next = await this.executor.run({
      command: () => connection.incrby(physicalKey, by),
      operation: 'increment'
    })
    if (next.isFailure()) return failure(next.value)

    const windowInMs: number | undefined = input.windowInMs

    if (windowInMs !== undefined) {
      /*
       * NX, so the window is anchored to the first increment. A bare PEXPIRE would push the
       * expiry out on every call, and a fixed-window limiter whose window never closes under
       * sustained traffic is a limit that latches shut forever.
       */
      const windowed = await this.executor.run({
        command: () => connection.pexpire(physicalKey, windowInMs, 'NX'),
        operation: 'increment'
      })
      if (windowed.isFailure()) return failure(windowed.value)
    }

    return success({ value: next.value })
  }

  public async decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value
    const by: number = input.by ?? 1

    const next = await this.executor.run({
      command: () => connection.decrby(physicalKey, by),
      operation: 'decrement'
    })
    if (next.isFailure()) return failure(next.value)

    return success({ value: next.value })
  }

  public async getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    const key = await this.keys.physicalKey(input)
    if (key.isFailure()) return failure(key.value)

    const master = this.connections.master()
    if (master.isFailure()) return failure(master.value)

    const connection = master.value
    const physicalKey: string = key.value

    const raw = await this.executor.run({
      command: () => connection.get(physicalKey),
      operation: 'getCounter'
    })
    if (raw.isFailure()) return failure(raw.value)

    /*
     * Absent counts as zero: "never incremented" and "counted down to nothing" are the same
     * answer to a rate limiter, and a null would make every call site handle a case it cannot act on.
     */
    if (raw.value === null) return success({ value: 0 })

    const parsed = Number(raw.value)

    return success({ value: Number.isFinite(parsed) ? parsed : 0 })
  }
}
