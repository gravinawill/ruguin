import { ID } from '@ruguin/shared-domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { type TransactionContext } from '../../../../../../shared/domain/contracts/transaction-context.contract'
import { type PrismaService } from '../../../../../../shared/infrastructure/database/prisma/prisma.service'
import { createTestPrismaService } from '../../../../../../shared/infrastructure/outbox/__tests__/outbox-test-context'
import { Email } from '../../../../domain/models/email.model'
import { EmailRepository } from '../email.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Email' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildEmail(input: { projectId: string; idempotencyKey: string | null }) {
  const result = Email.create({
    id: validId(),
    projectId: input.projectId,
    templateId: null,
    idempotencyKey: input.idempotencyKey,
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello</p>',
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

describe('EmailRepository#createIfNotExists (integration)', () => {
  let prisma: PrismaService
  const repository = new EmailRepository()

  beforeAll(() => {
    prisma = createTestPrismaService()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await prisma.email.deleteMany()
  })

  it('lets two concurrent inserts with the same (projectId, idempotencyKey) resolve to one row and one winner', async () => {
    const projectId = `project-${validId().toString()}`
    const first = buildEmail({ projectId, idempotencyKey: 'concurrent-key' })
    const second = buildEmail({ projectId, idempotencyKey: 'concurrent-key' })

    const [firstResult, secondResult] = await Promise.all([
      prisma.$transaction((tx) =>
        repository.createIfNotExists({ email: first, tx: tx as unknown as TransactionContext })
      ),
      prisma.$transaction((tx) =>
        repository.createIfNotExists({ email: second, tx: tx as unknown as TransactionContext })
      )
    ])

    expect(firstResult.isSuccess()).toBe(true)
    expect(secondResult.isSuccess()).toBe(true)
    if (!firstResult.isSuccess() || !secondResult.isSuccess()) return

    const createdFlags = [firstResult.value.created, secondResult.value.created].toSorted(
      (a, b) => Number(a) - Number(b)
    )
    expect(createdFlags).toEqual([false, true])
    expect(firstResult.value.email.id.toString()).toBe(secondResult.value.email.id.toString())

    const rowCount = await prisma.email.count({ where: { projectId, idempotencyKey: 'concurrent-key' } })
    expect(rowCount).toBe(1)
  })

  it('allows two inserts with no idempotencyKey for the same project without colliding', async () => {
    const projectId = `project-${validId().toString()}`
    const first = buildEmail({ projectId, idempotencyKey: null })
    const second = buildEmail({ projectId, idempotencyKey: null })

    const firstResult = await prisma.$transaction((tx) =>
      repository.createIfNotExists({ email: first, tx: tx as unknown as TransactionContext })
    )
    const secondResult = await prisma.$transaction((tx) =>
      repository.createIfNotExists({ email: second, tx: tx as unknown as TransactionContext })
    )

    expect(firstResult.isSuccess() && firstResult.value.created).toBe(true)
    expect(secondResult.isSuccess() && secondResult.value.created).toBe(true)
  })
})
