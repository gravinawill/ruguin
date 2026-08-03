import { type SendEmailCommand, type SESClient } from '@aws-sdk/client-ses'
import { describe, expect, it, vi } from 'vitest'

import { SesEmailSender } from '../ses-email-sender.ts'

function fakeSesClient(send: SESClient['send']): SESClient {
  return { send } as unknown as SESClient
}

describe('SesEmailSender', () => {
  it('sends the email and returns the SES message id', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'ses-msg-1' })
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({ from: 'a@ruguin.dev', to: 'b@ruguin.dev', subject: 'Hi', html: '<p>Hi</p>' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.sesMessageId).toBe('ses-msg-1')
    }

    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0]?.[0] as SendEmailCommand
    expect(command.input).toEqual({
      Source: 'a@ruguin.dev',
      Destination: { ToAddresses: ['b@ruguin.dev'] },
      Message: {
        Subject: { Data: 'Hi' },
        Body: { Html: { Data: '<p>Hi</p>' } }
      }
    })
  })

  it('returns a SesSendError when the SDK call rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttled'))
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({ from: 'a@ruguin.dev', to: 'b@ruguin.dev', subject: 'Hi', html: '<p>Hi</p>' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('SesSendError')
    }
  })

  it('returns a SesSendError instead of an empty sesMessageId when SES reports no MessageId', async () => {
    const send = vi.fn().mockResolvedValue({})
    const sender = new SesEmailSender(fakeSesClient(send))

    const result = await sender.send({ from: 'a@ruguin.dev', to: 'b@ruguin.dev', subject: 'Hi', html: '<p>Hi</p>' })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value.name).toBe('SesSendError')
    }
  })
})
