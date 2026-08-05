import { ID } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type PrismaService } from '../../../../../../shared/infrastructure/database/prisma/prisma.service'
import { SenderIdentity } from '../../../../domain/models/sender-identity.model'
import { SenderIdentityRepository } from '../sender-identity.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity(overrides: Partial<{ verifiedAt: Date | null }> = {}) {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email: 'will@gravina.dev',
    verifiedAt: overrides.verifiedAt ?? null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

describe('SenderIdentityRepository', () => {
  describe('create', () => {
    it('persists the row and returns the mapped domain model', async () => {
      const senderIdentity = buildSenderIdentity()
      const create = vi.fn().mockResolvedValue({
        id: senderIdentity.id.toString(),
        projectId: senderIdentity.projectId,
        name: senderIdentity.name,
        email: senderIdentity.email,
        verifiedAt: null,
        createdAt: senderIdentity.createdAt
      })
      const prisma = { senderIdentity: { create } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.create({ senderIdentity })

      expect(result.isSuccess()).toBe(true)
      expect(create).toHaveBeenCalledWith({
        data: {
          id: senderIdentity.id.toString(),
          projectId: 'project-1',
          name: 'Will Gravina',
          email: 'will@gravina.dev',
          verifiedAt: null
        }
      })
    })

    it('maps a P2002 violation to DuplicateSenderIdentityEmailError', async () => {
      const senderIdentity = buildSenderIdentity()
      const create = vi.fn().mockRejectedValue({ code: 'P2002' })
      const prisma = { senderIdentity: { create } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.create({ senderIdentity })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('DuplicateSenderIdentityEmailError')
    })

    it('maps any other thrown error to CreateSenderIdentityError', async () => {
      const senderIdentity = buildSenderIdentity()
      const create = vi.fn().mockRejectedValue(new Error('connection reset'))
      const prisma = { senderIdentity: { create } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.create({ senderIdentity })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('CreateSenderIdentityError')
    })
  })

  describe('findById', () => {
    it('returns { senderIdentity: null } when no row matches', async () => {
      const findUnique = vi.fn().mockResolvedValue(null)
      const prisma = { senderIdentity: { findUnique } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findById({ id: validId().toString() })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.senderIdentity).toBeNull()
    })

    it('maps a found row into a SenderIdentity', async () => {
      const senderIdentity = buildSenderIdentity()
      const findUnique = vi.fn().mockResolvedValue({
        id: senderIdentity.id.toString(),
        projectId: senderIdentity.projectId,
        name: senderIdentity.name,
        email: senderIdentity.email,
        verifiedAt: null,
        createdAt: senderIdentity.createdAt
      })
      const prisma = { senderIdentity: { findUnique } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findById({ id: senderIdentity.id.toString() })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.senderIdentity?.email).toBe('will@gravina.dev')
    })
  })

  describe('findManyByProjectId', () => {
    it('maps every row scoped to the project, ordered by createdAt', async () => {
      const senderIdentity = buildSenderIdentity()
      const findMany = vi.fn().mockResolvedValue([
        {
          id: senderIdentity.id.toString(),
          projectId: senderIdentity.projectId,
          name: senderIdentity.name,
          email: senderIdentity.email,
          verifiedAt: null,
          createdAt: senderIdentity.createdAt
        }
      ])
      const prisma = { senderIdentity: { findMany } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findManyByProjectId({ projectId: 'project-1' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value.senderIdentities).toHaveLength(1)
      expect(findMany).toHaveBeenCalledWith({ where: { projectId: 'project-1' }, orderBy: { createdAt: 'asc' } })
    })
  })

  describe('findUnverified', () => {
    it('queries rows with verifiedAt IS NULL', async () => {
      const findMany = vi.fn().mockResolvedValue([])
      const prisma = { senderIdentity: { findMany } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.findUnverified()

      expect(result.isSuccess()).toBe(true)
      expect(findMany).toHaveBeenCalledWith({ where: { verifiedAt: null } })
    })
  })

  describe('markVerified', () => {
    it('updates verifiedAt on the given row', async () => {
      const update = vi.fn().mockResolvedValue({})
      const prisma = { senderIdentity: { update } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)
      const verifiedAt = new Date('2026-08-05T12:00:00Z')

      const result = await repository.markVerified({ id: 'sender-1', verifiedAt })

      expect(result.isSuccess()).toBe(true)
      expect(update).toHaveBeenCalledWith({ where: { id: 'sender-1' }, data: { verifiedAt } })
    })

    it('maps a thrown error to FindSenderIdentityError', async () => {
      const update = vi.fn().mockRejectedValue(new Error('db down'))
      const prisma = { senderIdentity: { update } } as unknown as PrismaService
      const repository = new SenderIdentityRepository(prisma)

      const result = await repository.markVerified({ id: 'sender-1', verifiedAt: new Date() })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value.name).toBe('FindSenderIdentityError')
    })
  })
})
