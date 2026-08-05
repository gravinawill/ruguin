import { describe, expect, it } from 'vitest'

import { OUTBOX_PORT } from '../outbox.port'

describe('OUTBOX_PORT', () => {
  it('is a symbol, so it cannot collide with a string-keyed provider token', () => {
    expect(typeof OUTBOX_PORT).toBe('symbol')
  })

  it('stays the same reference across imports, so every module injects the same provider', async () => {
    const { OUTBOX_PORT: reimported } = await import('../outbox.port')

    expect(reimported).toBe(OUTBOX_PORT)
  })

  it('is distinct from any other symbol sharing its description', () => {
    expect(OUTBOX_PORT).not.toBe(Symbol('OUTBOX_PORT'))
  })
})
