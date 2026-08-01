import { describe, expect, it } from 'vitest'

import { ValkeyCommandExecutor } from '../valkey-command.executor.ts'

const never = async (): Promise<string> =>
  new Promise<string>(() => {
    // Deliberately never settles: the executor's own budget is what has to end this call.
  })

describe('ValkeyCommandExecutor', () => {
  it('passes a successful reply straight through', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 100 })

    const result = await executor.run({ command: () => Promise.resolve('OK'), operation: 'set' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value).toBe('OK')
  })

  it('turns a client rejection into a connection error naming the operation', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 100 })
    const cause = new Error('ECONNREFUSED')

    const result = await executor.run({ command: () => Promise.reject(cause), operation: 'get' })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheConnectionError')
    expect(result.value.message).toContain('get')
    expect(result.value.error).toBe(cause)
  })

  it('gives up on a command that never answers, and says what the budget was', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 20 })

    const result = await executor.run({ command: never, operation: 'get' })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.name).toBe('CacheTimeoutError')
    expect(result.value.message).toContain('20')
  })

  /*
   * The health check hands its own budget down so a slow INFO does not fail under the tight
   * per-operation timeout that the hot path is tuned for.
   */
  it('lets a caller override the budget for one call', async () => {
    const executor = new ValkeyCommandExecutor({ timeoutInMs: 10_000 })

    const result = await executor.run({ command: never, operation: 'healthCheck', timeoutInMs: 20 })

    if (result.isSuccess()) throw new Error('expected failure')
    expect(result.value.message).toContain('20')
  })
})
