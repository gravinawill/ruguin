import { describe, expect, it } from 'vitest'

import { CACHE_MODULE_OPTIONS, CACHE_PROVIDER, CONTRACT_TOKENS } from '../cache.tokens.ts'

describe('cache tokens', () => {
  it('gives every contract its own symbol', () => {
    expect(new Set(CONTRACT_TOKENS).size).toBe(CONTRACT_TOKENS.length)
  })

  /*
   * CACHE_PROVIDER is the alias target, so listing it among the aliases would make the module
   * register a provider that resolves to itself.
   */
  it('keeps the composite and the internal options token out of the alias list', () => {
    expect(CONTRACT_TOKENS).not.toContain(CACHE_PROVIDER)
    expect(CONTRACT_TOKENS).not.toContain(CACHE_MODULE_OPTIONS)
  })

  it('covers the twenty-four granular contracts of ICacheDriver plus the two orchestrators', () => {
    expect(CONTRACT_TOKENS).toHaveLength(24)
  })
})
