import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('sesENV', () => {
  const originalEnvironment = { ...process.env }

  beforeEach(() => {
    delete process.env.SES_SEND_RATE_LIMIT_PER_SECOND
    process.env.SES_FROM_ADDRESS = 'sender@ruguin.dev'
  })

  afterEach(() => {
    process.env = { ...originalEnvironment }
  })

  it('requires SES_FROM_ADDRESS', async () => {
    delete process.env.SES_FROM_ADDRESS

    vi.resetModules()
    const { sesENV } = await import('../ses.environment.ts')

    expect(() => ({ ...sesENV })).toThrow()
  })

  it('defaults SES_SEND_RATE_LIMIT_PER_SECOND to 14', async () => {
    vi.resetModules()
    const { sesENV } = await import('../ses.environment.ts')

    expect(sesENV.SES_SEND_RATE_LIMIT_PER_SECOND).toBe(14)
  })
})
