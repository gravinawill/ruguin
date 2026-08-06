import { randomUUID } from 'node:crypto'

import { ID } from '@ruguin/shared-domain'
import { afterAll, describe, expect, it } from 'vitest'

import { createTestPrismaService } from '../../../../../../shared/infrastructure/outbox/__tests__/outbox-test-context'
import { SenderIdentity } from '../../../../domain/models/sender-identity.model'
import { SenderIdentityRepository } from '../sender-identity.repository'

const prisma = createTestPrismaService()
const repository = new SenderIdentityRepository(prisma)

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

async function seedProject(): Promise<string> {
  const organization = await prisma.organization.create({ data: { name: `Org ${randomUUID()}` } })
  const project = await prisma.project.create({
    data: { organizationId: organization.id, name: `Project ${randomUUID()}` }
  })
  return project.id
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe('SenderIdentityRepository (integration)', () => {
  it('rejects a second sender identity with the same email, even from a different project', async () => {
    const email = `will+${randomUUID()}@gravina.dev`
    const firstProjectId = await seedProject()
    const secondProjectId = await seedProject()

    const first = SenderIdentity.create({
      id: validId(),
      projectId: firstProjectId,
      name: 'Will Gravina',
      email,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (first.isFailure()) throw new Error('unreachable')
    const firstResult = await repository.create({ senderIdentity: first.value })
    expect(firstResult.isSuccess()).toBe(true)

    const second = SenderIdentity.create({
      id: validId(),
      projectId: secondProjectId,
      name: 'Someone Else',
      email,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (second.isFailure()) throw new Error('unreachable')
    const secondResult = await repository.create({ senderIdentity: second.value })

    expect(secondResult.isFailure()).toBe(true)
    if (secondResult.isFailure()) expect(secondResult.value.name).toBe('DuplicateSenderIdentityEmailError')
  })

  it('findUnverified only returns rows with verifiedAt IS NULL', async () => {
    const projectId = await seedProject()

    const unverified = SenderIdentity.create({
      id: validId(),
      projectId,
      name: 'Unverified',
      email: `unverified+${randomUUID()}@gravina.dev`,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (unverified.isFailure()) throw new Error('unreachable')
    await repository.create({ senderIdentity: unverified.value })

    const verified = SenderIdentity.create({
      id: validId(),
      projectId,
      name: 'Verified',
      email: `verified+${randomUUID()}@gravina.dev`,
      verifiedAt: new Date(),
      createdAt: new Date()
    })
    if (verified.isFailure()) throw new Error('unreachable')
    const verifiedCreated = await repository.create({ senderIdentity: verified.value })
    if (verifiedCreated.isFailure()) throw new Error('unreachable')

    const result = await repository.findUnverified()

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      const ids = result.value.senderIdentities.map((s) => s.id.toString())
      expect(ids).toContain(unverified.value.id.toString())
      expect(ids).not.toContain(verifiedCreated.value.id.toString())
    }
  })

  it('markVerified sets verifiedAt so a subsequent findById reflects it', async () => {
    const projectId = await seedProject()
    const senderIdentity = SenderIdentity.create({
      id: validId(),
      projectId,
      name: 'To Verify',
      email: `to-verify+${randomUUID()}@gravina.dev`,
      verifiedAt: null,
      createdAt: new Date()
    })
    if (senderIdentity.isFailure()) throw new Error('unreachable')
    const created = await repository.create({ senderIdentity: senderIdentity.value })
    if (created.isFailure()) throw new Error('unreachable')

    const verifiedAt = new Date()
    const markResult = await repository.markVerified({ id: created.value.id.toString(), verifiedAt })
    expect(markResult.isSuccess()).toBe(true)

    const found = await repository.findById({ id: created.value.id.toString() })
    expect(found.isSuccess()).toBe(true)
    if (found.isSuccess()) expect(found.value.senderIdentity?.isVerified()).toBe(true)
  })
})
