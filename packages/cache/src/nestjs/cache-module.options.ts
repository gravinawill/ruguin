import { type FactoryProvider, type ModuleMetadata } from '@nestjs/common'

import { type CacheFactoryDTO, type OnCacheError } from '../index.ts'

/*
 * The factory's own config minus onCacheError, which the module can supply for you: reporting a
 * swallowed cache failure is exactly the kind of thing a framework adapter knows how to do and the
 * framework-agnostic core does not. Everything else stays required — a cache whose prefix or TTL
 * was silently defaulted is a cache nobody can reason about from the call site.
 */
export type CacheModuleFactoryOptions = Readonly<
  Omit<CacheFactoryDTO.Config, 'onCacheError'> & { onCacheError?: OnCacheError }
>

export type CacheModuleOptions = Readonly<CacheModuleFactoryOptions & { isGlobal?: boolean }>

/*
 * `never[]` rather than `any[]`: it is the one parameter list every factory shape is assignable to
 * under strictFunctionTypes, and it keeps `any` out of the public surface.
 */
export type CacheModuleAsyncOptions = Readonly<{
  imports?: NonNullable<ModuleMetadata['imports']>
  inject?: NonNullable<FactoryProvider['inject']>
  isGlobal?: boolean
  useFactory: (...dependencies: never[]) => CacheModuleFactoryOptions | Promise<CacheModuleFactoryOptions>
}>
