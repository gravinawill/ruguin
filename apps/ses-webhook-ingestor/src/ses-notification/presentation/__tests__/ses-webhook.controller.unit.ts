import { InternalServerErrorException } from '@nestjs/common'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import {
  type IngestSesNotificationInput,
  type IngestSesNotificationUseCase
} from '../../application/use-cases/ingest-ses-notification.use-case.ts'
import { SesWebhookController } from '../ses-webhook.controller.ts'

function buildController(execute = vi.fn().mockResolvedValue(success({ outcome: 'published' }))): {
  controller: SesWebhookController
  execute: ReturnType<typeof vi.fn>
} {
  const useCase = { execute } as unknown as IngestSesNotificationUseCase

  return { controller: new SesWebhookController(useCase), execute }
}

function inputPassedTo(execute: ReturnType<typeof vi.fn>): IngestSesNotificationInput {
  return execute.mock.calls[0]?.[0] as IngestSesNotificationInput
}

describe('SesWebhookController', () => {
  it('converts a well-formed EventBridge envelope into a valid domain event', async () => {
    const { controller, execute } = buildController()
    const body = {
      id: 'evt-1',
      source: 'aws.ses',
      detail: { eventType: 'Bounce', mail: { messageId: 'ses-msg-1' }, bounce: { bounceType: 'Permanent' } }
    }

    await controller.handle(body)

    const input = inputPassedTo(execute)
    expect(input.kind).toBe('valid')
    if (input.kind === 'valid') {
      expect(input.eventBridgeId).toBe('evt-1')
      expect(input.event.sesMessageId).toBe('ses-msg-1')
      expect(input.event.status).toBe('bounced')
      expect(input.event.bounceType).toBe('Permanent')
    }
  })

  it('reports a body the envelope schema rejects as malformed', async () => {
    const { controller, execute } = buildController()

    const response = await controller.handle({ not: 'valid' })

    expect(response).toEqual({ status: 'ok' })
    const input = inputPassedTo(execute)
    expect(input.kind).toBe('malformed')
    if (input.kind === 'malformed') expect(input.rawBody).toEqual({ not: 'valid' })
  })

  /*
   * The envelope schema types messageId as z.string().min(1), which a whitespace-only string
   * satisfies — only SesNotificationEvent.create()'s trim() rejects it. Without this the model's
   * failure branch in toUseCaseInput would be reachable in production but never exercised.
   */
  it('reports a schema-valid envelope the domain model rejects as malformed', async () => {
    const { controller, execute } = buildController()
    const body = {
      id: 'evt-2',
      source: 'aws.ses',
      detail: { eventType: 'Delivery', mail: { messageId: ' '.repeat(3) } }
    }

    const response = await controller.handle(body)

    expect(response).toEqual({ status: 'ok' })
    const input = inputPassedTo(execute)
    expect(input.kind).toBe('malformed')
    if (input.kind === 'malformed') {
      expect(input.rawBody).toBe(body)
      expect(input.reason).toBe('sesMessageId must not be empty')
    }
  })

  it('answers 500 only when the use case reports a genuine failure', async () => {
    const { controller } = buildController(
      vi.fn().mockResolvedValue(failure({ name: 'MessagePublishError', message: 'kafka down' }))
    )

    await expect(controller.handle({ not: 'valid' })).rejects.toThrow(InternalServerErrorException)
  })
})
