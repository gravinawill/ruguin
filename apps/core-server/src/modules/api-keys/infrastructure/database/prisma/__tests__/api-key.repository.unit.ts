import { describe, expect, it, vi } from 'vitest'

import { ApiKeyRepository } from '../api-key.repository'

function createPrismaStub(
  row: { id: string; projectId: string; hashedKey: string; revokedAt: Date | null; createdAt: Date } | null
) {
  const findFirst = vi.fn().mockResolvedValue(row)

  return {
    prisma: { apiKey: { findFirst } } as unknown as ConstructorParameters<typeof ApiKeyRepository>[0],
    findFirst
  }
}

describe('ApiKeyRepository#findActiveByHashedKey', () => {
  it('maps a found, active row into an ApiKey', async () => {
    const { prisma, findFirst } = createPrismaStub({
      id: '0198f3b2-1234-7000-8000-000000000030',
      projectId: 'project-1',
      hashedKey: 'a'.repeat(64),
      revokedAt: null,
      createdAt: new Date('2026-01-01')
    })
    const repository = new ApiKeyRepository(prisma)

    const result = await repository.findActiveByHashedKey({ hashedKey: 'a'.repeat(64) })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.apiKey?.projectId).toBe('project-1')
    /*
     * The revocation check has to live inside the query itself — asserting only the returned
     * value would still pass if the repository fetched by hashedKey alone and filtered
     * revokedAt afterwards in application code, which is exactly the anti-pattern this
     * repository exists to avoid.
     */
    expect(findFirst).toHaveBeenCalledWith({ where: { hashedKey: 'a'.repeat(64), revokedAt: null } })
  })

  it('returns { apiKey: null } when no active row matches (unknown or revoked key)', async () => {
    const { prisma, findFirst } = createPrismaStub(null)
    const repository = new ApiKeyRepository(prisma)

    const result = await repository.findActiveByHashedKey({ hashedKey: 'b'.repeat(64) })

    expect(result.isSuccess()).toBe(true)
    if (result.isSuccess()) expect(result.value.apiKey).toBeNull()
    expect(findFirst).toHaveBeenCalledWith({ where: { hashedKey: 'b'.repeat(64), revokedAt: null } })
  })
})
