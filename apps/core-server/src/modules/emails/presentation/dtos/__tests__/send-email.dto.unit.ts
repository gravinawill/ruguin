import { describe, expect, it } from 'vitest'

import { SendEmailBodySchema } from '../send-email.dto'

describe('SendEmailBodySchema', () => {
  it('accepts a valid { to, templateId, variables } body', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      variables: { name: 'Ada' }
    })

    expect(result.success).toBe(true)
  })

  it('defaults variables to {} when omitted', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020'
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.variables).toEqual({})
  })

  it('rejects a body missing templateId', () => {
    const result = SendEmailBodySchema.safeParse({ to: 'recipient@example.com' })

    expect(result.success).toBe(false)
  })

  it('rejects an invalid "to" address', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'not-an-email',
      templateId: '0198f3b2-1234-7000-8000-000000000020'
    })

    expect(result.success).toBe(false)
  })

  it('rejects a body carrying an unknown field like "from"', () => {
    const result = SendEmailBodySchema.safeParse({
      to: 'recipient@example.com',
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      from: 'sender@example.com'
    })

    expect(result.success).toBe(false)
  })
})
