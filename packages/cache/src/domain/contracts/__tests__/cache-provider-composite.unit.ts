import { describe, expect, it } from 'vitest'

import { type ICacheProvider, type IGetCacheProvider, type IHealthCheckProvider } from '../index'

const assertGet = (provider: IGetCacheProvider): IGetCacheProvider => provider
const assertHealth = (provider: IHealthCheckProvider): IHealthCheckProvider => provider

const asGranular = (provider: ICacheProvider): void => {
  assertGet(provider)
  assertHealth(provider)
}

describe('ICacheProvider', () => {
  it('is assignable to each granular contract it composes', () => {
    expect(typeof asGranular).toBe('function')
  })
})
