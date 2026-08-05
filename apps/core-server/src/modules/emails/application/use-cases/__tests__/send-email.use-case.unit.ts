import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { describe, expect, it, vi } from 'vitest'

import { type OutboxPort } from '../../../../../shared/domain/contracts/outbox.port'
import { type TransactionContext } from '../../../../../shared/domain/contracts/transaction-context.contract'
import { type TransactionManager } from '../../../../../shared/domain/contracts/transaction-manager.contract'
import { EnqueueOutboxMessageError } from '../../../../../shared/domain/errors/enqueue-outbox-message.error'
import { type TemplateLookupProvider } from '../../../../templates/domain/contracts/template-lookup.provider'
import { TemplateNotFoundError } from '../../../../templates/domain/errors/template-not-found.error'
import { Template } from '../../../../templates/domain/models/template.model'
import { type EmailRepository } from '../../../domain/contracts/repositories/email.repository'
import { CreateEmailError } from '../../../domain/errors/models/create-email.error'
import { InvalidEmailPayloadError } from '../../../domain/errors/models/invalid-email-payload.error'
import { Email } from '../../../domain/models/email.model'
import { SendEmailUseCase } from '../send-email.use-case'

function validId(modelName: string): ID {
  const generated = ID.generate({ modelName })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildTemplate() {
  const result = Template.create({
    id: validId('Template'),
    projectId: '01900000-0000-7000-8000-000000000001',
    name: 'Welcome',
    subject: 'Hi {{name}}',
    html: '<p>Hi {{name}}</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function buildEmail(overrides: Partial<{ idempotencyKey: string | null }> = {}) {
  const result = Email.create({
    id: validId('Email'),
    projectId: '01900000-0000-7000-8000-000000000001',
    templateId: null,
    idempotencyKey: overrides.idempotencyKey ?? null,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hi Ada',
    html: '<p>Hi Ada</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function createTransactionManagerStub(): TransactionManager {
  return {
    execute: async (work) => work({} as TransactionContext)
  }
}

describe('SendEmailUseCase', () => {
  it('renders the template, persists the email, and enqueues email.send.requested when the row is new', async () => {
    const email = buildEmail()
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const template = buildTemplate()
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const enqueue = vi.fn().mockResolvedValue(success(undefined))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, templateLookup, outbox)
    const requestedTemplateId = template.id.toString()

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: requestedTemplateId,
      variables: { name: 'Ada' }
    })

    expect(result.isSuccess()).toBe(true)
    // Proves the *rendered* output — not the raw template, and not some other field — is what got persisted.
    expect(createIfNotExists).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          templateId: requestedTemplateId,
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'Hi Ada',
          html: '<p>Hi Ada</p>'
        })
      })
    )
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [event, options] = enqueue.mock.calls[0] as [
      { name: string; payload: unknown },
      { topic: string; key: string }
    ]
    expect(options.topic).toBe('email.send.requested')
    expect(event.payload).toMatchObject({
      organizationId: '01900000-0000-7000-8000-000000000002',
      projectId: '01900000-0000-7000-8000-000000000001'
    })
  })

  it('does not enqueue a second event when the row already existed (idempotent replay)', async () => {
    const email = buildEmail({ idempotencyKey: 'idem-1' })
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: false }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      idempotencyKey: 'idem-1'
    })

    expect(result.isSuccess()).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('includes idempotencyKey in the enqueued payload when the row is new and one was supplied', async () => {
    const email = buildEmail({ idempotencyKey: 'idem-1' })
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn().mockResolvedValue(success(undefined))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      idempotencyKey: 'idem-1'
    })

    expect(result.isSuccess()).toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [event] = enqueue.mock.calls[0] as [{ payload: unknown }]
    expect(event.payload).toMatchObject({ idempotencyKey: 'idem-1' })
  })

  it('fails with TemplateNotFoundError when the templateId does not resolve for this project', async () => {
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template: null }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, templateLookup, outbox)

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: 'missing-template',
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(TemplateNotFoundError)
    expect(createIfNotExists).not.toHaveBeenCalled()
  })

  it('fails with MissingTemplateVariableError and never persists when a variable is missing', async () => {
    const template = buildTemplate()
    const findByIdAndProjectId = vi.fn().mockResolvedValue(success({ template }))
    const templateLookup: TemplateLookupProvider = { findByIdAndProjectId }
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const outbox: OutboxPort = { enqueue: vi.fn() }
    const useCase = new SendEmailUseCase(createTransactionManagerStub(), emailRepository, templateLookup, outbox)

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      templateId: template.id.toString(),
      variables: {}
    })

    expect(result.isFailure()).toBe(true)
    expect(createIfNotExists).not.toHaveBeenCalled()
  })

  it('uses subject/html directly when no templateId is given', async () => {
    const email = buildEmail()
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn().mockResolvedValue(success(undefined))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.isSuccess()).toBe(true)
  })

  it('propagates a repository failure without enqueueing', async () => {
    const persistenceError = new CreateEmailError({ error: new Error('db down') })
    const createIfNotExists = vi.fn().mockResolvedValue(failure(persistenceError))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.isFailure()).toBe(true)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('fails with InvalidEmailPayloadError and never enqueues when the built payload fails schema validation', async () => {
    /*
     * Email.create only checks "from" is non-empty (not real email format) — the outbox payload
     * schema is stricter (z.email()), so this string clears the domain model but must still
     * trip the defensive safeParse backstop before any transaction opens.
     */
    const createIfNotExists = vi.fn()
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueue = vi.fn()
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'not-an-email',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(InvalidEmailPayloadError)
    expect(createIfNotExists).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rolls the transaction back to failure when the outbox enqueue fails on a newly created row', async () => {
    const email = buildEmail()
    const createIfNotExists = vi.fn().mockResolvedValue(success({ email, created: true }))
    const emailRepository: EmailRepository = { createIfNotExists }
    const enqueueError = new EnqueueOutboxMessageError({ error: new Error('kafka unreachable') })
    const enqueue = vi.fn().mockResolvedValue(failure(enqueueError))
    const outbox: OutboxPort = { enqueue }
    const useCase = new SendEmailUseCase(
      createTransactionManagerStub(),
      emailRepository,
      { findByIdAndProjectId: vi.fn() },
      outbox
    )

    const result = await useCase.execute({
      projectId: '01900000-0000-7000-8000-000000000001',
      organizationId: '01900000-0000-7000-8000-000000000002',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>'
    })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBe(enqueueError)
  })
})
