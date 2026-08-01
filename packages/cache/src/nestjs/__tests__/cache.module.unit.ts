import 'reflect-metadata'

import { Inject, Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { failure } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import {
  CacheConnectionError,
  CacheConsistency,
  CacheDriver,
  type ICacheProvider,
  type IGetCacheProvider
} from '../../domain'
import { CacheModule } from '../cache.module'
import { CACHE_PROVIDER, CONTRACT_TOKENS, GET_CACHE_PROVIDER, HEALTH_CHECK_PROVIDER } from '../cache.tokens'
import { type CacheModuleFactoryOptions } from '../cache-module.options'
import { InjectCache } from '../inject-cache.decorator'

const baseOptions = (overrides: Partial<CacheModuleFactoryOptions> = {}): CacheModuleFactoryOptions => ({
  breaker: { failureThreshold: 5, resetTimeoutInMs: 10_000 },
  defaultConsistency: CacheConsistency.EVENTUAL,
  defaultTtlInMs: 300_000,
  driver: CacheDriver.MEMORY,
  invalidationBroadcast: false,
  jitterRatio: 0,
  lockTtlInMs: 5000,
  namespaceVersionLocalTtlInMs: 5000,
  negativeTtlInMs: 30_000,
  observability: false,
  operationTimeoutInMs: 500,
  prefix: 'ruguin:test',
  replicationLagThresholdInBytes: 1_048_576,
  ...overrides
})

@Injectable()
class ReaderService {
  public readonly reader: IGetCacheProvider

  constructor(@Inject(GET_CACHE_PROVIDER) reader: IGetCacheProvider) {
    this.reader = reader
  }
}

@Injectable()
class FacadeService {
  public readonly cache: ICacheProvider

  constructor(@InjectCache() cache: ICacheProvider) {
    this.cache = cache
  }
}

describe('CacheModule.forRoot', () => {
  it('resolves every contract token to the one instance the factory produced', async () => {
    const moduleReference = await Test.createTestingModule({ imports: [CacheModule.forRoot(baseOptions())] }).compile()

    const composite = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)
    for (const token of CONTRACT_TOKENS) {
      expect(moduleReference.get(token)).toBe(composite)
    }

    await moduleReference.close()
  })

  it('serves both the granular and the composite injection points from that same instance', async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [CacheModule.forRoot(baseOptions())],
      providers: [FacadeService, ReaderService]
    }).compile()

    const composite = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)

    expect(moduleReference.get(ReaderService).reader).toBe(composite)
    expect(moduleReference.get(FacadeService).cache).toBe(composite)

    await moduleReference.close()
  })

  it('marks the module global only when asked', () => {
    expect(CacheModule.forRoot(baseOptions()).global).toBe(false)
    expect(CacheModule.forRoot({ ...baseOptions(), isGlobal: true }).global).toBe(true)
  })

  /*
   * isGlobal is a module-registration concern; letting it reach CacheFactory.create would mean the
   * factory silently accepting a field it knows nothing about.
   */
  it('keeps isGlobal out of the options handed to the factory', async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ ...baseOptions(), isGlobal: true })]
    }).compile()

    expect(moduleReference.get<ICacheProvider>(CACHE_PROVIDER)).toBeDefined()

    await moduleReference.close()
  })

  it('refuses to build when the factory rejects the configuration', async () => {
    const compiling = Test.createTestingModule({
      imports: [CacheModule.forRoot(baseOptions({ driver: CacheDriver.VALKEY }))]
    }).compile()

    await expect(compiling).rejects.toThrow('InvalidCacheConfigError')
  })

  it('connects on module init and disconnects on shutdown', async () => {
    const moduleReference = await Test.createTestingModule({ imports: [CacheModule.forRoot(baseOptions())] }).compile()

    const cache = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)
    const connect = vi.spyOn(cache, 'connect')
    const disconnect = vi.spyOn(cache, 'disconnect')

    await moduleReference.init()
    expect(connect).toHaveBeenCalledTimes(1)

    await moduleReference.close()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  /*
   * The premise of the whole fail-open design: a cache that cannot be reached degrades the service,
   * it does not stop it. If this ever starts rejecting, a Valkey outage becomes an API outage.
   */
  it('boots even when connect fails', async () => {
    const moduleReference = await Test.createTestingModule({ imports: [CacheModule.forRoot(baseOptions())] }).compile()

    const cache = moduleReference.get<ICacheProvider>(CACHE_PROVIDER)
    vi.spyOn(cache, 'connect').mockResolvedValue(failure(new CacheConnectionError({ operation: 'connect' })))

    await expect(moduleReference.init()).resolves.toBeDefined()

    await moduleReference.close()
  })
})

@Module({ providers: [{ provide: 'PREFIX', useValue: 'ruguin:async' }], exports: ['PREFIX'] })
class PrefixModule {}

describe('CacheModule.forRootAsync', () => {
  it('builds the provider from an injected factory', async () => {
    const moduleReference = await Test.createTestingModule({
      imports: [
        CacheModule.forRootAsync({
          imports: [PrefixModule],
          inject: ['PREFIX'],
          useFactory: (prefix: string) => baseOptions({ prefix })
        })
      ]
    }).compile()

    expect(moduleReference.get(HEALTH_CHECK_PROVIDER)).toBe(moduleReference.get(CACHE_PROVIDER))

    await moduleReference.close()
  })

  it('accepts an async factory and honours isGlobal', async () => {
    const definition = CacheModule.forRootAsync({
      isGlobal: true,
      useFactory: () => Promise.resolve(baseOptions())
    })

    expect(definition.global).toBe(true)

    const moduleReference = await Test.createTestingModule({ imports: [definition] }).compile()
    expect(moduleReference.get(CACHE_PROVIDER)).toBeDefined()

    await moduleReference.close()
  })
})
