import { describe, expect, it } from 'vitest'

import { SendEmailBodySchema } from '../send-email.dto'

describe('SendEmailBodySchema', () => {
  it('accepts a template-based body', () => {
    const result = SendEmailBodySchema.safeParse({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      variables: { name: 'Ada' }
    })

    expect(result.success).toBe(true)
  })

  it('accepts a direct subject/html body', () => {
    const result = SendEmailBodySchema.safeParse({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.success).toBe(true)
  })

  it('rejects a body with neither templateId nor subject+html', () => {
    const result = SendEmailBodySchema.safeParse({ from: 'sender@example.com', to: 'recipient@example.com' })

    expect(result.success).toBe(false)
  })

  it('rejects an invalid "from" address', () => {
    const result = SendEmailBodySchema.safeParse({
      from: 'not-an-email',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.success).toBe(false)
  })

  it('rejects a body mixing templateId with subject/html', () => {
    const result = SendEmailBodySchema.safeParse({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.success).toBe(false)
  })
})
