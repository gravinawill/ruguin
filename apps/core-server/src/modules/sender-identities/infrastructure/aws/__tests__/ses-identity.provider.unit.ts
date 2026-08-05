import { type SESv2Client } from '@aws-sdk/client-sesv2'
import { describe, expect, it, vi } from 'vitest'

import { AwsSesIdentityProvider } from '../ses-identity.provider'

describe('AwsSesIdentityProvider', () => {
  describe('createIdentity', () => {
    it('calls CreateEmailIdentityCommand with the given email', async () => {
      const send = vi.fn().mockResolvedValue({})
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.createIdentity({ email: 'will@gravina.dev' })

      expect(result.isSuccess()).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      const [command] = send.mock.calls[0] as [{ input: { EmailIdentity: string } }]
      expect(command.input).toEqual({ EmailIdentity: 'will@gravina.dev' })
    })

    it('maps a rejected send() into CreateSesIdentityError', async () => {
      const send = vi.fn().mockRejectedValue(new Error('rate limited'))
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.createIdentity({ email: 'will@gravina.dev' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('CreateSesIdentityError')
    })
  })

  describe('getVerificationStatus', () => {
    it('reports verified: true when SES reports VerifiedForSendingStatus true', async () => {
      const send = vi.fn().mockResolvedValue({ VerifiedForSendingStatus: true })
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.getVerificationStatus({ email: 'will@gravina.dev' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.verified).toBe(true)
    })

    it('reports verified: false when SES reports VerifiedForSendingStatus false or absent', async () => {
      const send = vi.fn().mockResolvedValue({ VerifiedForSendingStatus: false })
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.getVerificationStatus({ email: 'will@gravina.dev' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.verified).toBe(false)
    })

    it('maps a rejected send() into CheckSesIdentityError', async () => {
      const send = vi.fn().mockRejectedValue(new Error('not found'))
      const client = { send } as unknown as SESv2Client
      const provider = new AwsSesIdentityProvider(client)

      const result = await provider.getVerificationStatus({ email: 'will@gravina.dev' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('CheckSesIdentityError')
    })
  })
})
