import { CacheLockOutcome, CacheSource, type IDeleteCacheProvider, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type SenderIdentityRepository } from '../../../domain/contracts/repositories/sender-identity.repository'
import { FindSenderIdentityError } from '../../../domain/errors/find-sender-identity.error'
import { SenderIdentity } from '../../../domain/models/sender-identity.model'
import { SenderIdentityCacheProvider } from '../sender-identity-cache.provider'

/*
 * The provider reads coreServerENV.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS on every call, and
 * coreServerENV is one combined schema validated in full on first property access — same reasoning
 * as api-key-auth.guard.unit.ts's own beforeAll block.
 */
beforeAll(() => {
  vi.stubEnv('ENVIRONMENT', 'test')
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/ruguin?schema=core_server')
  vi.stubEnv('CACHE_PREFIX', 'ruguin:core-server')
  vi.stubEnv('KAFKA_BOOTSTRAP_BROKERS', 'localhost:9092')
  vi.stubEnv('DOCS_USERNAME', 'admin')
  vi.stubEnv('DOCS_PASSWORD', 'super-secret')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function validId(): ID {
  const generated = ID.generate({ modelName: 'SenderIdentity' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildSenderIdentity() {
  const result = SenderIdentity.create({
    id: validId(),
    projectId: 'project-1',
    name: 'Will Gravina',
    email: 'will@gravina.dev',
    verifiedAt: null,
    createdAt: new Date()
  })
  if (result.isFailure()) throw new Error('unreachable')
  return result.value
}

function createGetOrSetStub(): IGetOrSetCacheProvider {
  return {
    getOrSet: vi.fn(async ({ loader }) => {
      const loaded = await loader()
      if (loaded.isFailure()) return failure(loaded.value)

      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
    })
  } as unknown as IGetOrSetCacheProvider
}

describe('SenderIdentityCacheProvider', () => {
  describe('get', () => {
    it('runs the loader through getOrSet, keyed by the sender identity id, with a colon-free namespace', async () => {
      const senderIdentity = buildSenderIdentity()
      const repository = {
        findById: vi.fn().mockResolvedValue(success({ senderIdentity }))
      } as unknown as SenderIdentityRepository
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, cache, cacheInvalidator)

      const result = await cacheProvider.get({ senderIdentityId: senderIdentity.id.toString() })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value?.email).toBe('will@gravina.dev')
      const [options] = (cache.getOrSet as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { key: string; namespace: string; ttlInMs: number }
      ]
      expect(options.key).toBe(senderIdentity.id.toString())
      expect(options.namespace).not.toMatch(/[\s:]/)
      expect(Number.isSafeInteger(options.ttlInMs)).toBe(true)
    })

    it('propagates a repository failure through the loader', async () => {
      const repository = {
        findById: vi.fn().mockResolvedValue(failure(new FindSenderIdentityError({})))
      } as unknown as SenderIdentityRepository
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, cache, cacheInvalidator)

      const result = await cacheProvider.get({ senderIdentityId: 'sender-1' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value).toBeInstanceOf(FindSenderIdentityError)
    })

    it('resolves null when the repository finds no matching row', async () => {
      const repository = {
        findById: vi.fn().mockResolvedValue(success({ senderIdentity: null }))
      } as unknown as SenderIdentityRepository
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, cache, cacheInvalidator)

      const result = await cacheProvider.get({ senderIdentityId: 'unknown' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value).toBeNull()
    })
  })

  describe('invalidate', () => {
    it('calls delete with the same namespace used by get', async () => {
      const repository = { findById: vi.fn() } as unknown as SenderIdentityRepository
      const cache = { getOrSet: vi.fn() } as unknown as IGetOrSetCacheProvider
      const deleteFunction = vi.fn().mockResolvedValue(success({ existed: true }))
      const cacheInvalidator = { delete: deleteFunction } as unknown as IDeleteCacheProvider
      const cacheProvider = new SenderIdentityCacheProvider(repository, cache, cacheInvalidator)

      await cacheProvider.invalidate({ senderIdentityId: 'sender-1' })

      expect(deleteFunction).toHaveBeenCalledWith({ key: 'sender-1', namespace: 'core-server-sender-identity' })
    })
  })
})
