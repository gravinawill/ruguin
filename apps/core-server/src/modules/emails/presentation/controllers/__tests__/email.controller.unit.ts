import { ID } from '@ruguin/shared-domain'
import { success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type SendEmailService } from '../../../application/services/send-email.service'
import { InvalidSendEmailRequestError } from '../../../domain/errors/models/invalid-send-email-request.error'
import { Email } from '../../../domain/models/email.model'
import { EmailController } from '../email.controller'

/*
 * SendEmailService's constructor-injected sendEmailUseCase is `private`, so TS treats it as part
 * of the class's structural shape when checking an object literal against `SendEmailService`
 * itself — the literal below has no way to supply that field and fails to type-check. Picking only
 * the public method keeps the fake typed against the same contract EmailController actually calls.
 */
type SendEmailServiceLike = Pick<SendEmailService, 'execute'>

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail() {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: null,
    idempotencyKey: null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi',
    html: '<p>Hi</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

describe('EmailController#send', () => {
  it('returns { id, status: "queued" } on success', async () => {
    const email = buildEmail()
    const service: SendEmailServiceLike = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service as SendEmailService)

    const response = await controller.send(
      { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' },
      undefined,
      { projectId: 'project-1', organizationId: 'org-1' }
    )

    expect(response).toEqual({ id: email.id.toString(), status: 'queued' })
  })

  it('throws InvalidSendEmailRequestError for a body matching neither shape', async () => {
    const service: SendEmailServiceLike = { execute: vi.fn() }
    const controller = new EmailController(service as SendEmailService)

    await expect(
      controller.send({ from: 'sender@example.com', to: 'recipient@example.com' }, undefined, {
        projectId: 'project-1',
        organizationId: 'org-1'
      })
    ).rejects.toBeInstanceOf(InvalidSendEmailRequestError)
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('throws whatever BaseError the service returns as a failure', async () => {
    class FakeError extends Error {}
    const service: SendEmailServiceLike = {
      execute: vi.fn().mockResolvedValue({ isFailure: () => true, isSuccess: () => false, value: new FakeError() })
    }
    const controller = new EmailController(service as SendEmailService)

    await expect(
      controller.send(
        { from: 'sender@example.com', to: 'recipient@example.com', subject: 'Hi', html: '<p>Hi</p>' },
        undefined,
        {
          projectId: 'project-1',
          organizationId: 'org-1'
        }
      )
    ).rejects.toBeInstanceOf(FakeError)
  })
})
