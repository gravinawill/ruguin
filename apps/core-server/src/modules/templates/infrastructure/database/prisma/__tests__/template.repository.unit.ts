import { describe, expect, it, vi } from 'vitest'

import { TemplateRepository } from '../template.repository'

function createPrismaStub(
  row: { id: string; projectId: string; name: string; subject: string; html: string; createdAt: Date } | null
) {
  const findFirst = vi.fn().mockResolvedValue(row)

  return {
    prisma: { template: { findFirst } } as unknown as ConstructorParameters<typeof TemplateRepository>[0],
    findFirst
  }
}

describe('TemplateRepository#findByIdAndProjectId', () => {
  it('maps a found row scoped to the project', async () => {
    const { prisma, findFirst } = createPrismaStub({
      id: '0198f3b2-1234-7000-8000-000000000020',
      projectId: 'project-1',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>',
      createdAt: new Date('2026-01-01')
    })
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      projectId: 'project-1'
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template?.subject).toBe('Hi {{name}}')
    /*
     * The tenant scoping has to live inside the query itself — asserting only the returned value
     * would still pass if the repository fetched by templateId alone and filtered projectId
     * afterwards in application code, which is exactly the cross-tenant read this repository
     * exists to make impossible.
     */
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: '0198f3b2-1234-7000-8000-000000000020', projectId: 'project-1' }
    })
  })

  it('returns { template: null } for a template owned by another project', async () => {
    const { prisma, findFirst } = createPrismaStub(null)
    const repository = new TemplateRepository(prisma)

    const result = await repository.findByIdAndProjectId({
      templateId: 'other-projects-template',
      projectId: 'project-1'
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template).toBeNull()
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'other-projects-template', projectId: 'project-1' } })
  })
})
