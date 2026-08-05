import { describe, expect, it } from 'vitest'

import { OrganizationRepository } from '../organization.repository'

function createPrismaStub(row: { id: string; name: string; createdAt: Date } | null) {
  return { organization: { findUnique: () => Promise.resolve(row) } } as unknown as ConstructorParameters<
    typeof OrganizationRepository
  >[0]
}

describe('OrganizationRepository#findById', () => {
  it('maps a found row into an Organization', async () => {
    const repository = new OrganizationRepository(
      createPrismaStub({ id: '0198f3b2-1234-7000-8000-000000000001', name: 'Acme', createdAt: new Date('2026-01-01') })
    )

    const result = await repository.findById({ organizationId: '0198f3b2-1234-7000-8000-000000000001' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.organization?.name).toBe('Acme')
    }
  })

  it('returns { organization: null } when the row does not exist', async () => {
    const repository = new OrganizationRepository(createPrismaStub(null))

    const result = await repository.findById({ organizationId: '0198f3b2-1234-7000-8000-000000000002' })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) {
      expect(result.value.organization).toBeNull()
    }
  })
})
