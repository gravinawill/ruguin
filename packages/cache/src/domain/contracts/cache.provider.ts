import {
  type IDeleteCacheProvider,
  type IGetCacheProvider,
  type IGetOrSetCacheProvider,
  type ISetCacheProvider,
  type ISetIfNotExistsCacheProvider
} from './cache/index.ts'
import { type IConnectProvider, type IDisconnectProvider } from './connection/index.ts'
import {
  type IDecrementCounterProvider,
  type IGetCounterProvider,
  type IIncrementCounterProvider
} from './counter/index.ts'
import { type IHealthCheckProvider } from './health/index.ts'
import {
  type IAcquireLockProvider,
  type IExecuteWithLockProvider,
  type IExtendLockProvider,
  type IReleaseLockProvider
} from './lock/index.ts'
import { type IInvalidateNamespaceProvider, type IResolveNamespaceVersionProvider } from './namespace/index.ts'
import {
  type ICountScoresProvider,
  type IGetRankProvider,
  type IGetScoreProvider,
  type IGetTopScoresProvider,
  type IIncrementScoreProvider,
  type IRemoveScoreProvider,
  type ISetScoreProvider
} from './score/index.ts'

/*
 * Split on purpose. A driver adapts one storage technology and implements only the leaf
 * operations. getOrSet and executeWithLock are orchestration built on those leaves — they
 * are identical for every driver, so they live in application/ and are composed in once,
 * rather than being reimplemented by valkey, memory and noop alike.
 */
export interface ICacheDriver
  extends
    IGetCacheProvider,
    ISetCacheProvider,
    IDeleteCacheProvider,
    ISetIfNotExistsCacheProvider,
    IIncrementCounterProvider,
    IDecrementCounterProvider,
    IGetCounterProvider,
    IAcquireLockProvider,
    IReleaseLockProvider,
    IExtendLockProvider,
    ISetScoreProvider,
    IIncrementScoreProvider,
    IGetScoreProvider,
    IGetRankProvider,
    IGetTopScoresProvider,
    IRemoveScoreProvider,
    ICountScoresProvider,
    IInvalidateNamespaceProvider,
    IResolveNamespaceVersionProvider,
    IConnectProvider,
    IDisconnectProvider,
    IHealthCheckProvider {}

export interface ICacheProvider extends ICacheDriver, IGetOrSetCacheProvider, IExecuteWithLockProvider {}
