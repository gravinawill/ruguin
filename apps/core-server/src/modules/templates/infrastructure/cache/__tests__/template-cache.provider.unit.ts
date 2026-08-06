import { CacheLockOutcome, CacheSource, type IDeleteCacheProvider, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { ID } from '@ruguin/shared-domain'
import { failure, success } from '@ruguin/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type TemplateLookupProvider } from '../../../domain/contracts/template-lookup.provider'
import { FindTemplateError } from '../../../domain/errors/find-template.error'
import { Template } from '../../../domain/models/template.model'
import { TemplateCacheProvider } from '../template-cache.provider'

/*
 * The provider reads coreServerENV.TEMPLATE_CACHE_TTL_IN_SECONDS on every call, and coreServerENV
 * is one combined schema validated in full on first property access — same reasoning as
 * sender-identity-cache.provider.unit.ts's own beforeAll block.
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
  const generated = ID.generate({ modelName: 'Template' })
  if (generated.isFailure()) throw new Error('unreachable')
  return generated.value.idGenerated
}

function buildTemplate() {
  const result = Template.create({
    id: validId(),
    projectId: 'project-1',
    senderIdentityId: 'sender-1',
    name: 'Welcome',
    subject: 'Hi {{name}}',
    html: '<p>Hi {{name}}</p>',
    text: 'Hi {{name}}',
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

/*
 * Simulates what every real ICacheDriver (including 'memory') actually does: the first getOrSet
 * call is a miss that stores the loader's return value; every call after that is a hit that
 * replays it through a JSON round-trip, exactly like JsonSerializerStrategy's
 * serialize()/deserialize() does — stripping the Template prototype. `createGetOrSetStub` above
 * never round-trips anything, so it could not have caught the bug this reproduces.
 */
function createGetOrSetStubWithSerializationRoundTrip(): IGetOrSetCacheProvider {
  let stored: unknown

  return {
    getOrSet: vi.fn(async ({ loader }) => {
      if (stored !== undefined) {
        // eslint-disable-next-line unicorn/prefer-structured-clone -- must be JSON, not structuredClone: structuredClone keeps this reproduction faithful to the real driver's string round-trip.
        const rehydratedFromJson: unknown = JSON.parse(JSON.stringify(stored))
        return success({
          value: rehydratedFromJson,
          source: CacheSource.CACHE,
          lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
        })
      }

      const loaded = await loader()
      if (loaded.isFailure()) return failure(loaded.value)

      stored = loaded.value
      return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
    })
  } as unknown as IGetOrSetCacheProvider
}

/*
 * Unlike createGetOrSetStubWithSerializationRoundTrip (one shared slot, single template id), this
 * keys the store by whatever `key` getOrSet was called with — the only way to reproduce the
 * multi-tenant scenario, where two calls share a templateId but must land in different cache
 * entries because they carry different projectId values.
 */
function createGetOrSetStubWithSharedKeyedStore(): IGetOrSetCacheProvider {
  const store = new Map<string, unknown>()

  return {
    getOrSet: vi.fn(
      async ({ key, loader }: { key: string; loader: () => Promise<{ isFailure(): boolean; value: unknown }> }) => {
        if (store.has(key)) {
          return success({
            value: store.get(key),
            source: CacheSource.CACHE,
            lockOutcome: CacheLockOutcome.NOT_ATTEMPTED
          })
        }

        const loaded = await loader()
        if (loaded.isFailure()) return failure(loaded.value)

        store.set(key, loaded.value)
        return success({ value: loaded.value, source: CacheSource.LOADER, lockOutcome: CacheLockOutcome.NOT_ATTEMPTED })
      }
    )
  } as unknown as IGetOrSetCacheProvider
}

describe('TemplateCacheProvider', () => {
  describe('get', () => {
    it('runs the loader through getOrSet, keyed by the template id, with a colon-free namespace', async () => {
      const template = buildTemplate()
      const lookup = {
        findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template }))
      } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const result = await cacheProvider.get({ templateId: template.id.toString(), projectId: 'project-1' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value?.text).toBe('Hi {{name}}')
      const [options] = (cache.getOrSet as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { key: string; namespace: string; ttlInMs: number }
      ]
      expect(options.key).toBe(`project-1-${template.id.toString()}`)
      expect(options.namespace).not.toMatch(/[\s:]/)
      expect(Number.isSafeInteger(options.ttlInMs)).toBe(true)
    })

    it('propagates a lookup failure through the loader', async () => {
      const lookup = {
        findByIdAndProjectId: vi.fn().mockResolvedValue(failure(new FindTemplateError({})))
      } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const result = await cacheProvider.get({ templateId: 'template-1', projectId: 'project-1' })

      expect(result.isFailure()).toBe(true)
      if (result.isFailure()) expect(result.value).toBeInstanceOf(FindTemplateError)
    })

    it('resolves null when the lookup finds no matching row', async () => {
      const lookup = {
        findByIdAndProjectId: vi.fn().mockResolvedValue(success({ template: null }))
      } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStub()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const result = await cacheProvider.get({ templateId: 'unknown', projectId: 'project-1' })

      expect(result.isSuccess()).toBe(true)
      if (result.isSuccess()) expect(result.value).toBeNull()
    })

    it('rehydrates a real Template instance from a cache hit, so text stays readable after the JSON round-trip', async () => {
      const template = buildTemplate()
      const findByIdAndProjectIdMock = vi.fn().mockResolvedValue(success({ template }))
      const lookup = { findByIdAndProjectId: findByIdAndProjectIdMock } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStubWithSerializationRoundTrip()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      const first = await cacheProvider.get({ templateId: template.id.toString(), projectId: 'project-1' })
      const second = await cacheProvider.get({ templateId: template.id.toString(), projectId: 'project-1' })

      expect(findByIdAndProjectIdMock).toHaveBeenCalledOnce()
      expect(first.isSuccess()).toBe(true)
      expect(second.isSuccess()).toBe(true)
      if (first.isSuccess() && second.isSuccess()) {
        expect(first.value).toBeInstanceOf(Template)
        expect(second.value).toBeInstanceOf(Template)
        // The bug this guards against: a plain, deserialized object has this as a field, not a Template method.
        expect(second.value?.text).toBe('Hi {{name}}')
        expect(second.value?.id.toString()).toBe(template.id.toString())
      }
    })

    it('keys the cache by projectId + templateId, so a miss for one tenant never poisons another tenant sharing the same templateId', async () => {
      const template = buildTemplate()
      const sharedTemplateId = template.id.toString()
      /*
       * The victim ('project-1') actually owns a template at this id; the attacker's project
       * ('project-attacker') does not — findByIdAndProjectId is scoped, so it reports not-found
       * for the attacker regardless of the id being real for someone else.
       */
      const findByIdAndProjectIdMock = vi.fn().mockImplementation(({ projectId }: { projectId: string }) => {
        if (projectId === 'project-1') return success({ template })
        return success({ template: null })
      })
      const lookup = { findByIdAndProjectId: findByIdAndProjectIdMock } as unknown as TemplateLookupProvider
      const cache = createGetOrSetStubWithSharedKeyedStore()
      const cacheInvalidator = { delete: vi.fn() } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      // Attacker's request warms the cache first, under its own key, with a null (not-found) result.
      const attackerResult = await cacheProvider.get({ templateId: sharedTemplateId, projectId: 'project-attacker' })
      // The real owner's request must still hit the loader and get the real template back.
      const ownerResult = await cacheProvider.get({ templateId: sharedTemplateId, projectId: 'project-1' })

      expect(attackerResult.isSuccess()).toBe(true)
      if (attackerResult.isSuccess()) expect(attackerResult.value).toBeNull()
      expect(ownerResult.isSuccess()).toBe(true)
      if (ownerResult.isSuccess()) expect(ownerResult.value?.id.toString()).toBe(sharedTemplateId)

      const calls = (cache.getOrSet as ReturnType<typeof vi.fn>).mock.calls as Array<[{ key: string }]>
      const [attackerOptions] = calls[0] as [{ key: string }]
      const [ownerOptions] = calls[1] as [{ key: string }]
      expect(attackerOptions.key).toBe(`project-attacker-${sharedTemplateId}`)
      expect(ownerOptions.key).toBe(`project-1-${sharedTemplateId}`)
      expect(attackerOptions.key).not.toBe(ownerOptions.key)
    })
  })

  describe('invalidate', () => {
    it('calls delete with a key scoped by projectId + templateId, using the same namespace as get', async () => {
      const lookup = { findByIdAndProjectId: vi.fn() } as unknown as TemplateLookupProvider
      const cache = { getOrSet: vi.fn() } as unknown as IGetOrSetCacheProvider
      const deleteFunction = vi.fn().mockResolvedValue(success({ existed: true }))
      const cacheInvalidator = { delete: deleteFunction } as unknown as IDeleteCacheProvider
      const cacheProvider = new TemplateCacheProvider(lookup, cache, cacheInvalidator)

      await cacheProvider.invalidate({ templateId: 'template-1', projectId: 'project-1' })

      expect(deleteFunction).toHaveBeenCalledWith({ key: 'project-1-template-1', namespace: 'core-server-template' })
    })
  })
})
