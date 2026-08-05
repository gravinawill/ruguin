import { describe, expect, it } from 'vitest'

import { TemplateRepository } from '../template.repository'

function createPrismaStub(
  row: { id: string; projectId: string; name: string; subject: string; html: string; createdAt: Date } | null
) {
  return { template: { findFirst: () => Promise.resolve(row) } } as unknown as ConstructorParameters<
    typeof TemplateRepository
  >[0]
}

describe('TemplateRepository#findByIdAndProjectId', () => {
  it('maps a found row scoped to the project', async () => {
    const repository = new TemplateRepository(
      createPrismaStub({
        id: '0198f3b2-1234-7000-8000-000000000020',
        projectId: 'project-1',
        name: 'Welcome',
        subject: 'Hi {{name}}',
        html: '<p>Hi {{name}}</p>',
        createdAt: new Date('2026-01-01')
      })
    )

    const result = await repository.findByIdAndProjectId({
      templateId: '0198f3b2-1234-7000-8000-000000000020',
      projectId: 'project-1'
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template?.subject).toBe('Hi {{name}}')
  })

  it('returns { template: null } for a template owned by another project', async () => {
    const repository = new TemplateRepository(createPrismaStub(null))

    const result = await repository.findByIdAndProjectId({
      templateId: 'other-projects-template',
      projectId: 'project-1'
    })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.template).toBeNull()
  })
})
