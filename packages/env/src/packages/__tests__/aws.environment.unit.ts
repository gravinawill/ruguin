import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('awsENV', () => {
  const originalEnvironment = { ...process.env }

  beforeEach(() => {
    /*
     * A developer's own shell (e.g. an AWS CLI profile) can already export these — clear them so
     * the default-value assertions below reflect the schema's defaults, not the ambient machine.
     */
    delete process.env.AWS_REGION
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    delete process.env.AWS_ENDPOINT_URL
  })

  afterEach(() => {
    process.env = { ...originalEnvironment }
  })

  it('defaults AWS_REGION to us-east-1', async () => {
    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_REGION).toBe('us-east-1')
  })

  it('reads AWS_ENDPOINT_URL when set, for LocalStack', async () => {
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566'

    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ENDPOINT_URL).toBe('http://localhost:4566')
  })

  it('parses with AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY absent, for a real AWS deployment using the default credential chain', async () => {
    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(awsENV.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  it('reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY when set, for LocalStack', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'test'
    process.env.AWS_SECRET_ACCESS_KEY = 'test'

    vi.resetModules()
    const { awsENV } = await import('../aws.environment.ts')

    expect(awsENV.AWS_ACCESS_KEY_ID).toBe('test')
    expect(awsENV.AWS_SECRET_ACCESS_KEY).toBe('test')
  })
})
