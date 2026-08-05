import { ID } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type TransactionContext } from '../../../../../../shared/domain/contracts/transaction-context.contract'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail(idempotencyKey: string | null) {
  const result = Email.create({
    id: validId(),
    projectId: 'project-1',
    templateId: null,
    idempotencyKey,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello</p>',
    createdAt: new Date('2026-08-04T00:00:00Z')
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
}) {
  return {
    /*
     * Mocked to a no-op: the repository issues SAVEPOINT/ROLLBACK TO SAVEPOINT around the
     * insert to survive Postgres aborting the transaction on a real unique-violation, but that
     * recovery is exercised against a real database in email.repository.int.ts, not here.
     */
    $executeRawUnsafe: vi.fn(() => Promise.resolve(0)),
    email: {
      create: ({ data }: { data: Record<string, unknown> }) => input.create(data),
      findFirst: input.findFirst ?? (() => Promise.resolve(null))
    }
  } as unknown as TransactionContext
}

describe('EmailRepository#createIfNotExists', () => {
  it('returns created: true and the persisted row on a fresh insert', async () => {
    const email = buildEmail('idem-1')
    const repository = new EmailRepository()
    const tx = createTxStub({
      create: (data) =>
        Promise.resolve({
          id: data.id,
          projectId: data.projectId,
          templateId: data.templateId,
          idempotencyKey: data.idempotencyKey,
          from: data.from,
          to: data.to,
          subject: data.subject,
          html: data.html,
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
      templateId: null,
      idempotencyKey: 'idem-1',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      createdAt: new Date('2026-08-04T00:00:00Z')
    }
    const repository = new EmailRepository()
    const tx = createTxStub({
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
  })

  it('maps any other thrown error into CreateEmailError', async () => {
    const email = buildEmail(null)
    const repository = new EmailRepository()
    const tx = createTxStub({
      create: () => {
        throw new Error('connection terminated unexpectedly')
      }
    })

    const result = await repository.createIfNotExists({ email, tx })

    expect(result.isFailure()).toBe(true)
  })
})
