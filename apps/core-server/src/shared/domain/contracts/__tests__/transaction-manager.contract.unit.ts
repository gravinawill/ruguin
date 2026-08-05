import { describe, expect, it } from 'vitest'

import { TRANSACTION_MANAGER } from '../transaction-manager.contract'

describe('TRANSACTION_MANAGER', () => {
  it('is a symbol, so it cannot collide with a string-keyed provider token', () => {
    expect(typeof TRANSACTION_MANAGER).toBe('symbol')
  })

  it('stays the same reference across imports, so every module injects the same provider', async () => {
    const { TRANSACTION_MANAGER: reimported } = await import('../transaction-manager.contract')

    expect(reimported).toBe(TRANSACTION_MANAGER)
  })

  it('is distinct from any other symbol sharing its description', () => {
    expect(TRANSACTION_MANAGER).not.toBe(Symbol('TRANSACTION_MANAGER'))
  })
})
