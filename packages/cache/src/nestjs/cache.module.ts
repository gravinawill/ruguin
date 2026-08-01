import { type DynamicModule, Logger, Module, type Provider } from '@nestjs/common'

import { type OnCacheError } from '../application'
import { type ICacheProvider } from '../domain'
import { CacheFactory } from '../factory'

import { CACHE_MODULE_OPTIONS, CACHE_PROVIDER, CONTRACT_TOKENS } from './cache.tokens'
import {
  type CacheModuleAsyncOptions,
  type CacheModuleFactoryOptions,
  type CacheModuleOptions
} from './cache-module.options'

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
export class CacheModule {
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
}
