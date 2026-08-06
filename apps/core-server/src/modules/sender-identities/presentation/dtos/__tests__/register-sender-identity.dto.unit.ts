import { describe, expect, it } from 'vitest'

import { RegisterSenderIdentityBodySchema } from '../register-sender-identity.dto'

describe('RegisterSenderIdentityBodySchema', () => {
  it('accepts a valid { name, email } body', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({ name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.success).toBe(true)
  })

  it.each([
    ['an empty name', { name: '', email: 'will@gravina.dev' }],
    ['an invalid email', { name: 'Will Gravina', email: 'not-an-email' }],
    [
      'a name containing a comma (RFC 5322 display-name-unsafe character)',
      { name: 'Will, Gravina', email: 'will@gravina.dev' }
    ],
    [
      'a name containing CRLF (email-header injection characters)',
      { name: 'Will\r\nBcc: evil@example.com', email: 'will@gravina.dev' }
    ],
    ['an unknown extra field', { name: 'Will Gravina', email: 'will@gravina.dev', isDefault: true }]
  ])('rejects %s', (_description, body) => {
    const result = RegisterSenderIdentityBodySchema.safeParse(body)

    expect(result.success).toBe(false)
  })
})
