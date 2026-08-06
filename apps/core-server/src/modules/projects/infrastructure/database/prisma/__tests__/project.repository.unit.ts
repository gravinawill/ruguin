import { describe, expect, it } from 'vitest'

import { ProjectRepository } from '../project.repository'

function createPrismaStub(row: { id: string; organizationId: string; name: string; createdAt: Date } | null) {
  return { project: { findUnique: () => Promise.resolve(row) } } as unknown as ConstructorParameters<
    typeof ProjectRepository
  >[0]
}

describe('ProjectRepository#findById', () => {
  it('maps a found row into a Project', async () => {
    const repository = new ProjectRepository(
      createPrismaStub({
        id: '0198f3b2-1234-7000-8000-000000000010',
        organizationId: '0198f3b2-1234-7000-8000-000000000001',
        name: 'Prod',
        createdAt: new Date('2026-01-01')
      })
    )

    const result = await repository.findById({ projectId: '0198f3b2-1234-7000-8000-000000000010' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.project?.organizationId).toBe('0198f3b2-1234-7000-8000-000000000001')
    }
  })

  it('returns { project: null } when the row does not exist', async () => {
    const repository = new ProjectRepository(createPrismaStub(null))

    const result = await repository.findById({ projectId: 'missing' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.project).toBeNull()
  })
})
