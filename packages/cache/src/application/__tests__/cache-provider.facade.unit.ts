import { success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { CacheSource, type IGetCacheProvider } from '../../domain/index.ts'
import { MemoryCacheDriver } from '../../infra/drivers/memory/index.ts'
import { KeyBuilder } from '../../infra/key-builder.ts'
import { JsonSerializerStrategy } from '../../infra/serializers/index.ts'
import { CacheProviderFacade } from '../cache-provider.facade.ts'
import { ExecuteWithLockProvider } from '../execute-with-lock.provider.ts'
import { GetOrSetCacheProvider } from '../get-or-set-cache.provider.ts'

const noop = (): void => undefined

const buildFacade = async (): Promise<CacheProviderFacade> => {
  const driver = new MemoryCacheDriver({
    keyBuilder: new KeyBuilder({ prefix: 'ruguin:test' }),
    serializer: new JsonSerializerStrategy(),
    defaultTtlInMs: 60_000,
    jitterRatio: 0
  })
  await driver.connect()

  return new CacheProviderFacade({
    driver,
    getOrSetProvider: new GetOrSetCacheProvider({
      reader: driver,
      writer: driver,
      lockAcquirer: driver,
      lockReleaser: driver,
      negativeTtlInMs: 30_000,
      lockTtlInMs: 5000,
      onCacheError: noop
    }),
    executeWithLockProvider: new ExecuteWithLockProvider({
      lockAcquirer: driver,
      lockReleaser: driver,
      onCacheError: noop
    })
  })
}

describe('CacheProviderFacade', () => {
  it('exposes leaf operations delegated to the driver', async () => {
    const facade = await buildFacade()

    await facade.set({ key: '1', namespace: 'user', value: 'v', ttlInMs: 1000 })
    const read = await facade.get<string>({ key: '1', namespace: 'user' })

    if (read.isFailure()) throw new Error('expected success')
    expect(read.value).toEqual({ found: true, value: 'v' })
  })

  it('exposes the orchestrated cache-aside on the same instance', async () => {
    const facade = await buildFacade()

    const first = await facade.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(success('fresh'))
    })
    const second = await facade.getOrSet<string, Error>({
      key: '1',
      namespace: 'user',
      loader: () => Promise.resolve(success('unused'))
    })

    if (first.isFailure() || second.isFailure()) throw new Error('expected success')
    expect(first.value.source).toBe(CacheSource.LOADER)
    expect(second.value.source).toBe(CacheSource.CACHE)
  })

  it('is injectable as a narrow contract, so consumers can honour ISP', async () => {
    const facade = await buildFacade()
    const readOnly: IGetCacheProvider = facade

    const result = await readOnly.get<string>({ key: 'absent', namespace: 'user' })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.found).toBe(false)
  })

  it('shares one lock namespace between executeWithLock and the driver', async () => {
    const facade = await buildFacade()

    const held = await facade.acquire({ key: 'job', namespace: 'dispatch', ttlInMs: 5000 })
    if (held.isFailure()) throw new Error('expected success')

    const contended = await facade.executeWithLock<string, Error>({
      key: 'job',
      namespace: 'dispatch',
      ttlInMs: 5000,
      task: () => Promise.resolve(success('should not run'))
    })

    expect(contended.isFailure()).toBe(true)
  })
})
