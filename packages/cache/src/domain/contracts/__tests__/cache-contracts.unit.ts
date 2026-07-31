import { type Either, failure, success } from '@ruguin/utils'
import { describe, expect, it } from 'vitest'

import { CacheSource } from '../../enums'
import {
  type GetCacheProviderDTO,
  type GetOrSetCacheProviderDTO,
  type IGetCacheProvider,
  type IGetOrSetCacheProvider,
  type IIncrementCounterProvider,
  type IncrementCounterProviderDTO,
  type ISerializerStrategy,
  type ISetCacheProvider,
  type SetCacheProviderDTO
} from '../index'

class StubProvider implements IGetCacheProvider, ISetCacheProvider, IIncrementCounterProvider, IGetOrSetCacheProvider {
  public get<T>(): GetCacheProviderDTO.Output<T> {
    return Promise.resolve(success({ found: false, value: null }))
  }

  public set(): SetCacheProviderDTO.Output {
    return Promise.resolve(success({ expiresAt: new Date(0) }))
  }

  public increment(): IncrementCounterProviderDTO.Output {
    return Promise.resolve(success({ value: 1 }))
  }

  public async getOrSet<T, E>(input: GetOrSetCacheProviderDTO.Input<T, E>): GetOrSetCacheProviderDTO.Output<T, E> {
    const loaded: Either<E, T | null> = await input.loader()
    if (loaded.isFailure()) return failure(loaded.value)
    return success({ value: loaded.value, source: CacheSource.LOADER })
  }
}

const jsonStub: ISerializerStrategy = {
  serialize: () => success({ serialized: '{}' }),
  deserialize: <T>() => success({ value: null as unknown as T })
}

describe('cache contracts', () => {
  it('lets one class satisfy several granular contracts at once', async () => {
    // Typed as the contract, not the class: that assignment is what the test is really about.
    const provider: IGetCacheProvider = new StubProvider()
    const result = await provider.get<{ id: string }>({ key: 'a', namespace: 'user' })

    expect(result.isSuccess()).toBe(true)
  })

  it('reports the loader as the source when the cache is empty', async () => {
    const provider: IGetOrSetCacheProvider = new StubProvider()
    const result = await provider.getOrSet<number, Error>({
      key: 'a',
      namespace: 'user',
      loader: () => Promise.resolve(success(42))
    })

    if (result.isFailure()) throw new Error('expected success')
    expect(result.value.source).toBe(CacheSource.LOADER)
    expect(result.value.value).toBe(42)
  })

  it('exposes a serializer strategy shaped for Either', () => {
    const serialized = jsonStub.serialize({ value: { id: '1' } })

    expect(serialized.isSuccess()).toBe(true)
  })
})
