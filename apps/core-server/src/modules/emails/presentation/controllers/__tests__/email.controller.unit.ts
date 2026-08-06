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
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey: null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi',
    html: '<p>Hi</p>',
    text: 'Hi',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

const VALID_BODY = { to: 'recipient@example.com', templateId: '0198f3b2-1234-7000-8000-000000000020', variables: {} }

describe('EmailController#send', () => {
  it('returns { id, status: "queued" } on success', async () => {
    const email = buildEmail()
    const service: SendEmailServiceLike = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service as SendEmailService)

    const response = await controller.send(VALID_BODY, undefined, { projectId: 'project-1', organizationId: 'org-1' })

    expect(response).toEqual({ id: email.id.toString(), status: 'queued' })
  })

  it.each([
    ['an absent header', undefined],
    ['an empty header', ''],
    ['a whitespace-only header', ' '.repeat(3)]
  ])('forwards no idempotencyKey at all for %s', async (_label, header) => {
    /*
     * '' is what an `Idempotency-Key:` with no value actually arrives as, and it is not a key: it
     * would survive the use case's `?? null` and only die at the outbox payload's min(1) as a 500.
     */
    const email = buildEmail()
    const service: SendEmailServiceLike = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service as SendEmailService)

    await controller.send(VALID_BODY, header, { projectId: 'project-1', organizationId: 'org-1' })

    expect(service.execute).toHaveBeenCalledWith(expect.not.objectContaining({ idempotencyKey: expect.anything() }))
  })

  it('forwards a non-blank Idempotency-Key header untouched', async () => {
    const email = buildEmail()
    const service: SendEmailServiceLike = { execute: vi.fn().mockResolvedValue(success(email)) }
    const controller = new EmailController(service as SendEmailService)

    await controller.send(VALID_BODY, 'idem-1', { projectId: 'project-1', organizationId: 'org-1' })

    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'idem-1' }))
  })

  it('throws InvalidSendEmailRequestError for a body missing templateId', async () => {
    const service: SendEmailServiceLike = { execute: vi.fn() }
    const controller = new EmailController(service as SendEmailService)

    await expect(
      controller.send({ to: 'recipient@example.com' }, undefined, { projectId: 'project-1', organizationId: 'org-1' })
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
      controller.send(VALID_BODY, undefined, { projectId: 'project-1', organizationId: 'org-1' })
    ).rejects.toBeInstanceOf(FakeError)
  })
})
