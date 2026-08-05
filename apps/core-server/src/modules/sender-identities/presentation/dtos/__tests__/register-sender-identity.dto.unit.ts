import { describe, expect, it } from 'vitest'

import { RegisterSenderIdentityBodySchema } from '../register-sender-identity.dto'

describe('RegisterSenderIdentityBodySchema', () => {
  it('accepts a valid { name, email } body', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({ name: 'Will Gravina', email: 'will@gravina.dev' })

    expect(result.success).toBe(true)
  })

  it('rejects an empty name', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({ name: '', email: 'will@gravina.dev' })

    expect(result.success).toBe(false)
  })

  it('rejects an invalid email', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({ name: 'Will Gravina', email: 'not-an-email' })

    expect(result.success).toBe(false)
  })

  it('rejects an unknown extra field', () => {
    const result = RegisterSenderIdentityBodySchema.safeParse({
      name: 'Will Gravina',
      email: 'will@gravina.dev',
      isDefault: true
    })

    expect(result.success).toBe(false)
  })
})
