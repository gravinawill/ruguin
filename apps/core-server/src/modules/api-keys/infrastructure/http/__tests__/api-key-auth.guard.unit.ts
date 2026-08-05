import { type ExecutionContext } from '@nestjs/common'
import { CacheLockOutcome, CacheSource, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type ProjectLookupProvider } from '../../../../projects/domain/contracts/project-lookup.provider'
import { Project } from '../../../../projects/domain/models/project.model'
import { type ApiKeyRepository } from '../../../domain/contracts/api-key.repository'
import { FindApiKeyError } from '../../../domain/errors/find-api-key.error'
import { hashApiKey } from '../../../domain/hash-api-key'
import { ApiKey } from '../../../domain/models/api-key.model'
import { ApiKeyAuthGuard } from '../api-key-auth.guard'
import { type AuthenticatedRequest } from '../authenticated-tenant'

/*
 * The guard reads coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS on every call, and coreServerENV is
 * one combined schema (server + database + cache + message-broker + docs) validated in full on
 * first property access — so even this one field requires every other required var to be set.
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

function validId(modelName: string): ID {
  const generated = ID.generate({ modelName })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function createContext(authorizationHeader: string | undefined) {
  const request = { headers: { authorization: authorizationHeader } } as AuthenticatedRequest
  const context = {
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext

  return { context, request }
}

function buildApiKey(revokedAt: Date | null) {
  const created = ApiKey.create({
    id: validId('ApiKey'),
    projectId: 'project-1',
    hashedKey: hashApiKey({ rawKey: 'sk-valid' }),
    revokedAt,
    createdAt: new Date()
  })
  if (created.isFailure()) throw new Error('unreachable')
  return created.value
}

function buildProject() {
  const created = Project.create({
    id: validId('Project'),
    organizationId: 'org-1',
    name: 'Prod',
    createdAt: new Date()
  })
  if (created.isFailure()) throw new Error('unreachable')
  return created.value
}

/*
 * Mirrors what the real GetOrSetCacheProvider does: run the loader, and on success wrap its value
 * in the { value, source, lockOutcome } envelope the contract promises — a passthrough stub would
 * hand the guard `AuthenticatedTenant` where it expects `{ value: AuthenticatedTenant | null, ... }`
 * and silently break `cached.value.value`.
 */
function createCacheStub(): IGetOrSetCacheProvider {
  /*
   * `getOrSet` is generic (<T, E>); a vi.fn callback's inferred type is a single concrete
   * signature, which TS never accepts as an implementation of a generic method. The cast is the
   * same escape hatch the other stubs in this file use — the shape is still enforced by every
   * assertion the tests make on the guard's observed behavior.
   */
  return {
    getOrSet: vi.fn(async ({ loader }) => {
      const loaded = await loader()
      if (loaded.isFailure()) return failure(loaded.value)

      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
    })
  } as unknown as IGetOrSetCacheProvider
}

describe('ApiKeyAuthGuard', () => {
  it('rejects a request with no Authorization header', async () => {
    const apiKeyRepository = { findActiveByHashedKey: vi.fn() } as unknown as ApiKeyRepository
    const projectLookup = { findById: vi.fn() } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context } = createContext(undefined)

    await expect(guard.canActivate(context)).rejects.toThrow('Missing or malformed Authorization header')
  })

  it('rejects an unknown or revoked API key', async () => {
    const apiKeyRepository = {
      findActiveByHashedKey: vi.fn().mockResolvedValue(success({ apiKey: null }))
    } as unknown as ApiKeyRepository
    const projectLookup = { findById: vi.fn() } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context } = createContext('Bearer sk-unknown')

    await expect(guard.canActivate(context)).rejects.toThrow('Unknown or revoked API key')
  })

  it('propagates an infrastructure failure from the API key lookup', async () => {
    const apiKeyRepository = {
      findActiveByHashedKey: vi.fn().mockResolvedValue(failure(new FindApiKeyError({})))
    } as unknown as ApiKeyRepository
    const projectLookup = { findById: vi.fn() } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context } = createContext('Bearer sk-valid')

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(FindApiKeyError)
  })

  it('attaches { projectId, organizationId } to the request for a valid, active key', async () => {
    const apiKeyRepository = {
      findActiveByHashedKey: vi.fn().mockResolvedValue(success({ apiKey: buildApiKey(null) }))
    } as unknown as ApiKeyRepository
    const projectLookup = {
      findById: vi.fn().mockResolvedValue(success({ project: buildProject() }))
    } as unknown as ProjectLookupProvider
    const guard = new ApiKeyAuthGuard(apiKeyRepository, projectLookup, createCacheStub())
    const { context, request } = createContext('Bearer sk-valid')

    const isResult = await guard.canActivate(context)

    expect(isResult).toBe(true)
    expect(request.authenticatedTenant).toEqual({ projectId: 'project-1', organizationId: 'org-1' })
  })
})
