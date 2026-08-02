import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('awsENV', () => {
  const originalEnvironment = { ...process.env }

  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'
    process.env.SES_FROM_ADDRESS = 'sender@ruguin.dev'
  })

  afterEach(() => {
    process.env = { ...originalEnvironment }
  })

  it('defaults AWS_REGION to us-east-1 and SES_SEND_RATE_LIMIT_PER_SECOND to 14', async () => {
    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_REGION).toBe('us-east-1')
    expect(awsENV.SES_SEND_RATE_LIMIT_PER_SECOND).toBe(14)
  })

  it('reads AWS_ENDPOINT_URL when set, for LocalStack', async () => {
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566'

    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ENDPOINT_URL).toBe('http://localhost:4566')
  })
})
