import { describe, expect, it } from 'vitest'

import { ApiKeyRepository } from '../api-key.repository'

function createPrismaStub(
  row: { id: string; projectId: string; hashedKey: string; revokedAt: Date | null; createdAt: Date } | null
) {
  return { apiKey: { findFirst: () => Promise.resolve(row) } } as unknown as ConstructorParameters<
    typeof ApiKeyRepository
  >[0]
}

describe('ApiKeyRepository#findActiveByHashedKey', () => {
  it('maps a found, active row into an ApiKey', async () => {
    const repository = new ApiKeyRepository(
      createPrismaStub({
        id: '0198f3b2-1234-7000-8000-000000000030',
        projectId: 'project-1',
        hashedKey: 'a'.repeat(64),
        revokedAt: null,
        createdAt: new Date('2026-01-01')
      })
    )

    const result = await repository.findActiveByHashedKey({ hashedKey: 'a'.repeat(64) })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.apiKey?.projectId).toBe('project-1')
  })

  it('returns { apiKey: null } when no active row matches (unknown or revoked key)', async () => {
    const repository = new ApiKeyRepository(createPrismaStub(null))

    const result = await repository.findActiveByHashedKey({ hashedKey: 'b'.repeat(64) })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.apiKey).toBeNull()
  })
})
