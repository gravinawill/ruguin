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

  it('matches the known SHA-256 digest for a fixed input', () => {
    /*
     * Precomputed via `sha256sum` / node:crypto for the literal 'sk-test-123' — pins the
     * algorithm itself, not just its output shape, so a switch to a different hash function
     * (same digest length) wouldn't slip past the format-only test above.
     */
    expect(hashApiKey({ rawKey: 'sk-test-123' })).toBe(
      'e0dbaa0c6455768bf812d8345ec96a2677d1e3bf17dbb0020b115c80092811e6'
    )
  })

  it('differs for different inputs', () => {
    expect(hashApiKey({ rawKey: 'sk-a' })).not.toBe(hashApiKey({ rawKey: 'sk-b' }))
  })
})
