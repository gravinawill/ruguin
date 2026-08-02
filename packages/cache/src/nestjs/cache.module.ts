import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider
} from '@nestjs/common'

import { CacheFactory } from '../factory/index.ts'
import { type ICacheProvider, type OnCacheError } from '../index.ts'

import { CACHE_MODULE_OPTIONS, CACHE_PROVIDER, CONTRACT_TOKENS } from './cache.tokens.ts'
import {
  type CacheModuleAsyncOptions,
  type CacheModuleFactoryOptions,
  type CacheModuleOptions
} from './cache-module.options.ts'

const LOGGER_CONTEXT = 'CacheModule'

const defaultOnCacheError = (): OnCacheError => {
  const logger = new Logger(LOGGER_CONTEXT)

  return (input) => {
    logger.warn(`cache ${input.operation} failed on ${input.namespace}:${input.key}`, input.error)
  }
}

/*
 * The one place the package's Either is consumed rather than propagated. Nest's DI has no failure
 * channel other than a throw, and a container that hands out a half-built cache is worse than one
 * that refuses to start: a missing master url is a boot-time programming error, in the same family
 * as an absent environment variable. The domain error travels as `cause` — BaseError does not
 * extend Error, so it cannot be thrown as-is.
 */
const buildCacheProvider = (): Provider => ({
  provide: CACHE_PROVIDER,
  useFactory: (options: CacheModuleFactoryOptions): ICacheProvider => {
    const created = CacheFactory.create({ ...options, onCacheError: options.onCacheError ?? defaultOnCacheError() })
    if (created.isFailure()) {
      throw new Error(`@ruguin/cache: ${created.value.name}: ${created.value.message}`, { cause: created.value })
    }

    return created.value
  },
  inject: [CACHE_MODULE_OPTIONS]
})

/* useExisting, not useClass or a second useFactory: the aliases must resolve to the same object. */
const buildContractAliases = (): Provider[] =>
  CONTRACT_TOKENS.map((token) => ({ provide: token, useExisting: CACHE_PROVIDER }))

@Module({})
export class CacheModule implements OnApplicationShutdown, OnModuleInit {
  private readonly cache: ICacheProvider
  private readonly logger = new Logger(LOGGER_CONTEXT)

  constructor(@Inject(CACHE_PROVIDER) cache: ICacheProvider) {
    this.cache = cache
  }

  public static forRoot(options: CacheModuleOptions): DynamicModule {
    const { isGlobal = false, ...factoryOptions } = options

    return {
      exports: [CACHE_PROVIDER, ...CONTRACT_TOKENS],
      global: isGlobal,
      module: this,
      providers: [
        { provide: CACHE_MODULE_OPTIONS, useValue: factoryOptions },
        buildCacheProvider(),
        ...buildContractAliases()
      ]
    }
  }

  public static forRootAsync(options: CacheModuleAsyncOptions): DynamicModule {
    return {
      exports: [CACHE_PROVIDER, ...CONTRACT_TOKENS],
      global: options.isGlobal ?? false,
      imports: options.imports ?? [],
      module: this,
      providers: [
        { provide: CACHE_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        buildCacheProvider(),
        ...buildContractAliases()
      ]
    }
  }

  /*
   * A dead cache must not be a dead application — that is the premise of the fail-open design
   * (spec §5.6: unhealthy means "the app stays alive, without cache"). A failed connect is therefore
   * reported and the boot continues; the health indicator is what tells the operator about it.
   */
  public async onModuleInit(): Promise<void> {
    const connected = await this.cache.connect()
    if (connected.isFailure()) {
      this.logger.error('cache connect failed on startup; the application will run without cache', connected.value)
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    const disconnected = await this.cache.disconnect()
    if (disconnected.isFailure()) {
      this.logger.warn('cache disconnect failed during shutdown', disconnected.value)
    }
  }
}
