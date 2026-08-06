import { ID, StatusError } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type TransactionContext } from '../../../../../../shared/domain/contracts/transaction-context.contract'
import { EmailIdempotencyConflictError } from '../../../../domain/errors/models/email-idempotency-conflict.error'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail(idempotencyKey: string | null, overrides: Partial<{ to: string; subject: string }> = {}) {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: 'template-1',
    senderIdentityId: 'sender-1',
    idempotencyKey,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello</p>',
    text: 'Hello',
    createdAt: new Date('2026-08-04T00:00:00Z'),
    ...overrides
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

class UniqueConstraintViolation extends Error {
  readonly code = 'P2002'
  constructor() {
    super('Unique constraint failed')
    this.name = 'PrismaClientKnownRequestError'
  }
}

function createTxStub(input: {
  create: (data: Record<string, unknown>) => Promise<unknown>
  findFirst?: () => Promise<unknown>
  executeRawUnsafe?: (query: string) => Promise<unknown>
}): { tx: TransactionContext; findFirst: ReturnType<typeof vi.fn>; executeRawUnsafe: ReturnType<typeof vi.fn> } {
  /*
   * The repository issues SAVEPOINT/ROLLBACK TO SAVEPOINT around the insert to survive Postgres
   * aborting the transaction on a real unique-violation; that recovery is exercised against a
   * real database in email.repository.int.ts. Mocked to a no-op here by default, but exposed as
   * a spy so a test can both assert it was called and inject a failure from it.
   */
  const executeRawUnsafe = vi.fn(input.executeRawUnsafe ?? (() => Promise.resolve(0)))
  const findFirst = vi.fn(input.findFirst ?? (() => Promise.resolve(null)))
  const tx = {
    $executeRawUnsafe: executeRawUnsafe,
    email: {
      create: ({ data }: { data: Record<string, unknown> }) => input.create(data),
      findFirst
    }
  } as unknown as TransactionContext

  return { executeRawUnsafe, findFirst, tx }
}

describe('EmailRepository#createIfNotExists', () => {
  it('returns created: true and the persisted row on a fresh insert', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: (data) =>
        Promise.resolve({
          id: data.id,
          projectId: data.projectId,
          templateId: data.templateId,
          senderIdentityId: data.senderIdentityId,
          idempotencyKey: data.idempotencyKey,
          from: data.from,
          to: data.to,
          subject: data.subject,
          html: data.html,
          text: data.text,
          createdAt: email.createdAt
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.created).toBe(true)
      expect(result.value.email.id.toString()).toBe(email.id.toString())
    }
  })

  it('returns created: false and the pre-existing row when the partial unique index rejects the insert', async () => {
    const email = buildEmail('idem-1')
    const existingRow = {
      id: '0198f3b2-1234-7000-8000-000000000099',
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const { findFirst, tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () => Promise.resolve(existingRow)
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.created).toBe(false)
      expect(result.value.email.id.toString()).toBe(existingRow.id)
    }
    /*
     * The recovery read has to be scoped by projectId in the query itself — looking the row up by
     * idempotencyKey alone would hand one tenant another tenant's email as its own replay.
     */
    expect(findFirst).toHaveBeenCalledWith({ where: { projectId: 'project-1', idempotencyKey: 'idem-1' } })
  })

  it('returns EmailIdempotencyConflictError when the key was already used with a different body', async () => {
    /*
     * Same key, different content: returning the pre-existing row as a successful replay would
     * report 202 for a message that is never queued and never sent — silent, permanent loss.
     */
    const email = buildEmail('idem-1', { to: 'someone-else@example.com', subject: 'Different subject' })
    const existingRow = {
      id: '0198f3b2-1234-7000-8000-000000000099',
      projectId: 'project-1',
      templateId: 'template-1',
      senderIdentityId: 'sender-1',
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () => Promise.resolve(existingRow)
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) {
      expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
      expect(result.value.status).toBe(StatusError.CONFLICT)
    }
  })

  it('treats a replay whose only difference is the rendered text as a conflict', async () => {
    /*
     * text is compared post-render, same reasoning already applied to html: two requests with the
     * same templateId but different variables are different emails, even if subject/html happen
     * to match.
     */
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () =>
        Promise.resolve({
          id: '0198f3b2-1234-7000-8000-000000000099',
          projectId: 'project-1',
          templateId: '0198f3b2-1234-7000-8000-000000000020',
          senderIdentityId: 'sender-1',
          idempotencyKey: 'idem-1',
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'Hello',
          html: '<p>Hello</p>',
          text: 'Hello, Ada',
          createdAt: new Date('2026-08-04T00:00:00Z')
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
  })

  it('treats a replay whose only difference is the rendered html as a conflict', async () => {
    /*
     * html is compared post-render, because that is what was persisted and what a replay would
     * re-send: two requests with the same templateId but different variables are different emails.
     */
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      findFirst: () =>
        Promise.resolve({
          id: '0198f3b2-1234-7000-8000-000000000099',
          projectId: 'project-1',
          templateId: '0198f3b2-1234-7000-8000-000000000020',
          senderIdentityId: 'sender-1',
          idempotencyKey: 'idem-1',
          from: 'sender@example.com',
          to: 'recipient@example.com',
          subject: 'Hello',
          html: '<p>Hello, Ada</p>',
          text: 'Hello',
          createdAt: new Date('2026-08-04T00:00:00Z')
        })
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    if (result.isFailure()) expect(result.value).toBeInstanceOf(EmailIdempotencyConflictError)
  })

  it('maps any other thrown error into CreateEmailError', async () => {
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => {
        throw new Error('connection terminated unexpectedly')
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })

  it('returns failure without querying findFirst when a P2002 fires and the email has no idempotencyKey', async () => {
    /*
     * A NULL idempotencyKey can never match the partial index's WHERE clause, so a P2002 here
     * can only be a primary-key collision, never a lost idempotency race — findFirst must never
     * run, or it could hand back an unrelated email as if it were "already sent this request".
     */
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const { findFirst, tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('returns failure, not a thrown rejection, when the SAVEPOINT call itself fails', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const { tx } = createTxStub({
      create: () => Promise.resolve({}),
      executeRawUnsafe: () => Promise.reject(new Error('connection terminated unexpectedly'))
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })

  it('returns failure, not a thrown rejection, when the ROLLBACK TO SAVEPOINT call itself fails', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    let isSavepointTaken = false
    const { tx } = createTxStub({
      create: () => {
        throw new UniqueConstraintViolation()
      },
      executeRawUnsafe: () => {
        /*
         * First call is the SAVEPOINT before the insert — let it succeed. Only the
         * ROLLBACK TO SAVEPOINT that follows the P2002 catch should fail.
         */
        if (!isSavepointTaken) {
          isSavepointTaken = true
          return Promise.resolve(0)
        }
        return Promise.reject(new Error('connection terminated unexpectedly'))
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })
})
