import {
  type AcquireLockProviderDTO,
  type ConnectProviderDTO,
  type CountScoresProviderDTO,
  type DecrementCounterProviderDTO,
  type DeleteCacheProviderDTO,
  type DisconnectProviderDTO,
  type ExecuteWithLockProviderDTO,
  type ExtendLockProviderDTO,
  type GetCacheProviderDTO,
  type GetCounterProviderDTO,
  type GetOrSetCacheProviderDTO,
  type GetRankProviderDTO,
  type GetScoreProviderDTO,
  type GetTopScoresProviderDTO,
  type HealthCheckProviderDTO,
  type ICacheDriver,
  type ICacheProvider,
  type IExecuteWithLockProvider,
  type IGetOrSetCacheProvider,
  type IncrementCounterProviderDTO,
  type IncrementScoreProviderDTO,
  type InvalidateNamespaceProviderDTO,
  type ReleaseLockProviderDTO,
  type RemoveScoreProviderDTO,
  type ResolveNamespaceVersionProviderDTO,
  type SetCacheProviderDTO,
  type SetIfNotExistsCacheProviderDTO,
  type SetScoreProviderDTO
} from '../domain/index.ts'

export class CacheProviderFacade implements ICacheProvider {
  private readonly driver: ICacheDriver
  private readonly cacheAside: IGetOrSetCacheProvider
  private readonly mutualExclusion: IExecuteWithLockProvider

  constructor(input: {
    driver: ICacheDriver
    getOrSetProvider: IGetOrSetCacheProvider
    executeWithLockProvider: IExecuteWithLockProvider
  }) {
    this.driver = input.driver
    this.cacheAside = input.getOrSetProvider
    this.mutualExclusion = input.executeWithLockProvider
  }

  public get<T>(input: GetCacheProviderDTO.Input): GetCacheProviderDTO.Output<T> {
    return this.driver.get<T>(input)
  }

  public set<T>(input: SetCacheProviderDTO.Input<T>): SetCacheProviderDTO.Output {
    return this.driver.set<T>(input)
  }

  public delete(input: DeleteCacheProviderDTO.Input): DeleteCacheProviderDTO.Output {
    return this.driver.delete(input)
  }

  public setIfNotExists<T>(input: SetIfNotExistsCacheProviderDTO.Input<T>): SetIfNotExistsCacheProviderDTO.Output {
    return this.driver.setIfNotExists<T>(input)
  }

  public getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E> {
    return this.cacheAside.getOrSet<T, E>(input)
  }

  public increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output {
    return this.driver.increment(input)
  }

  public decrement(input: DecrementCounterProviderDTO.Input): DecrementCounterProviderDTO.Output {
    return this.driver.decrement(input)
  }

  public getCounter(input: GetCounterProviderDTO.Input): GetCounterProviderDTO.Output {
    return this.driver.getCounter(input)
  }

  public acquire(input: AcquireLockProviderDTO.Input): AcquireLockProviderDTO.Output {
    return this.driver.acquire(input)
  }

  public release(input: ReleaseLockProviderDTO.Input): ReleaseLockProviderDTO.Output {
    return this.driver.release(input)
  }

  public extend(input: ExtendLockProviderDTO.Input): ExtendLockProviderDTO.Output {
    return this.driver.extend(input)
  }

  public executeWithLock<T, E>(input: ExecuteWithLockProviderDTO.Input<T, E>): ExecuteWithLockProviderDTO.Output<T, E> {
    return this.mutualExclusion.executeWithLock<T, E>(input)
  }

  public setScore(input: SetScoreProviderDTO.Input): SetScoreProviderDTO.Output {
    return this.driver.setScore(input)
  }

  public incrementScore(input: IncrementScoreProviderDTO.Input): IncrementScoreProviderDTO.Output {
    return this.driver.incrementScore(input)
  }

  public getScore(input: GetScoreProviderDTO.Input): GetScoreProviderDTO.Output {
    return this.driver.getScore(input)
  }

  public getRank(input: GetRankProviderDTO.Input): GetRankProviderDTO.Output {
    return this.driver.getRank(input)
  }

  public getTopScores(input: GetTopScoresProviderDTO.Input): GetTopScoresProviderDTO.Output {
    return this.driver.getTopScores(input)
  }

  public removeScore(input: RemoveScoreProviderDTO.Input): RemoveScoreProviderDTO.Output {
    return this.driver.removeScore(input)
  }

  public countScores(input: CountScoresProviderDTO.Input): CountScoresProviderDTO.Output {
    return this.driver.countScores(input)
  }

  public invalidateNamespace(input: InvalidateNamespaceProviderDTO.Input): InvalidateNamespaceProviderDTO.Output {
    return this.driver.invalidateNamespace(input)
  }

  public resolveNamespaceVersion(
    input: ResolveNamespaceVersionProviderDTO.Input
  ): ResolveNamespaceVersionProviderDTO.Output {
    return this.driver.resolveNamespaceVersion(input)
  }

  public connect(): ConnectProviderDTO.Output {
    return this.driver.connect()
  }

  public disconnect(): DisconnectProviderDTO.Output {
    return this.driver.disconnect()
  }

  public healthCheck(input?: HealthCheckProviderDTO.Input): HealthCheckProviderDTO.Output {
    return this.driver.healthCheck(input)
  }
}
