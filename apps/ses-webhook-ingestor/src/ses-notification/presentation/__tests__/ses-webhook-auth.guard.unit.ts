import { type ExecutionContext } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { isValidSharedSecret, SES_INGESTOR_SECRET_HEADER, SesWebhookAuthGuard } from '../ses-webhook-auth.guard.ts'

vi.hoisted(() => {
  process.env.SES_WEBHOOK_INGESTOR_SHARED_SECRET = 'correct-secret-that-is-at-least-32-chars-long'
  process.env.ENVIRONMENT = 'test'
  process.env.CACHE_PREFIX = 'ruguin:ses-webhook-ingestor-test'
  process.env.KAFKA_BOOTSTRAP_BROKERS = 'localhost:9092'
  process.env.DATABASE_URL = 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
})

function fakeContext(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as ExecutionContext
}

describe('isValidSharedSecret', () => {
  it('accepts a candidate equal to the expected secret', () => {
    expect(isValidSharedSecret('correct-secret', 'correct-secret')).toBe(true)
  })

  it('rejects an undefined candidate', () => {
    expect(isValidSharedSecret(undefined, 'correct-secret')).toBe(false)
  })

  it('rejects a candidate of a different length without throwing', () => {
    expect(isValidSharedSecret('short', 'a-much-longer-secret')).toBe(false)
  })

  it('rejects a same-length candidate that differs', () => {
    expect(isValidSharedSecret('wrong-secret', 'right-secret')).toBe(false)
  })
})

describe('SesWebhookAuthGuard', () => {
  it('allows a request carrying the correct secret header', () => {
    const guard = new SesWebhookAuthGuard()

    expect(
      guard.canActivate(fakeContext({ [SES_INGESTOR_SECRET_HEADER]: 'correct-secret-that-is-at-least-32-chars-long' }))
    ).toBe(true)
  })

  it('rejects a request with a missing header', () => {
    const guard = new SesWebhookAuthGuard()

    expect(() => guard.canActivate(fakeContext({}))).toThrow()
  })

  it('rejects a request with the wrong secret', () => {
    const guard = new SesWebhookAuthGuard()

    expect(() => guard.canActivate(fakeContext({ [SES_INGESTOR_SECRET_HEADER]: 'wrong' }))).toThrow()
  })
})
