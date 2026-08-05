import { ID } from '@ruguin/shared-domain'
import { describe, expect, it, vi } from 'vitest'

import { type PrismaService } from '../../../../../../shared/infrastructure/database/prisma/prisma.service'
import { TemplateRepository } from '../template.repository'

function validId(): ID {
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

describe('TemplateRepository#findByIdAndProjectId', () => {
  it('maps a found row scoped to the project', async () => {
    const id = validId()
    const findFirst = vi.fn().mockResolvedValue({
      id: id.toString(),
      projectId: 'project-1',
      senderIdentityId: 'sender-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date()
    })
    const prisma = { template: { findFirst } } as unknown as PrismaService
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({ templateId: id.toString(), projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template?.senderIdentityId).toBe('sender-1')
    expect(findFirst).toHaveBeenCalledWith({ where: { id: id.toString(), projectId: 'project-1' } })
  })

  it('returns { template: null } for a template owned by another project', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const prisma = { template: { findFirst } } as unknown as PrismaService
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({ templateId: validId().toString(), projectId: 'project-1' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template).toBeNull()
  })
})
