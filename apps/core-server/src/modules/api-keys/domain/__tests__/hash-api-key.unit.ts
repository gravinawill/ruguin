import { describe, expect, it } from 'vitest'

import { hashApiKey } from '../hash-api-key'

describe('hashApiKey', () => {
  it('is deterministic for the same input', () => {
    expect(hashApiKey({ rawKey: 'sk-test-123' })).toBe(hashApiKey({ rawKey: 'sk-test-123' }))
  })

  it('produces a 64-character lowercase hex digest (SHA-256)', () => {
    const hashed = hashApiKey({ rawKey: 'sk-test-123' })

    expect(hashed).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different inputs', () => {
    expect(hashApiKey({ rawKey: 'sk-a' })).not.toBe(hashApiKey({ rawKey: 'sk-b' }))
  })
})
