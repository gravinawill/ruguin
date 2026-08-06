import { Inject, Injectable } from '@nestjs/common'
import {
  DELETE_CACHE_PROVIDER,
  GET_OR_SET_CACHE_PROVIDER,
  type IDeleteCacheProvider,
  type IGetOrSetCacheProvider
} from '@ruguin/cache'
import { coreServerENV } from '@ruguin/env'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { type TemplateCacheProvider as TemplateCacheProviderContract } from '../../domain/contracts/template-cache.provider'
import { TEMPLATE_LOOKUP_PROVIDER, type TemplateLookupProvider } from '../../domain/contracts/template-lookup.provider'
import { FindTemplateError } from '../../domain/errors/find-template.error'
import { Template } from '../../domain/models/template.model'

// KeyBuilder.validateSegment forbids ':' in namespace/key segments — see packages/cache/src/infra/key-builder.ts.
const CACHE_NAMESPACE = 'core-server-template'

@Injectable()
export class TemplateCacheProvider implements TemplateCacheProviderContract {
  constructor(
    @Inject(TEMPLATE_LOOKUP_PROVIDER) private readonly lookup: TemplateLookupProvider,
    @Inject(GET_OR_SET_CACHE_PROVIDER) private readonly cache: IGetOrSetCacheProvider,
    @Inject(DELETE_CACHE_PROVIDER) private readonly cacheInvalidator: IDeleteCacheProvider
  ) {}

  public async get(input: {
    templateId: string
    projectId: string
  }): Promise<Either<FindTemplateError, Template | null>> {
    const cached = await this.cache.getOrSet<Template, FindTemplateError>({
      key: `${input.projectId}-${input.templateId}`,
      namespace: CACHE_NAMESPACE,
      ttlInMs: coreServerENV.TEMPLATE_CACHE_TTL_IN_SECONDS * 1000,
      loader: async () => {
        const result = await this.lookup.findByIdAndProjectId({
          templateId: input.templateId,
          projectId: input.projectId
        })
        if (result.isFailure()) return failure(result.value)
        return success(result.value.template)
      }
    })

    if (cached.isFailure()) return failure(cached.value)
    if (cached.value.value === null) return success(null)

    /*
     * getOrSet's cache HIT path round-trips every driver — including 'memory' — through
     * ISerializerStrategy (JSON.stringify/parse), which strips the Template prototype: the value
     * is a plain object shaped like Template, not an instance. Rehydrating unconditionally (hit or
     * miss) means both paths return the exact same guarantee — same bug class already found and
     * fixed in SenderIdentityCacheProvider (prior plan, Task 13).
     */
    return this.toDomain(cached.value.value)
  }

  private toDomain(raw: Template): Either<FindTemplateError, Template> {
    const idResult = ID.validate({ id: raw.id.value, modelName: 'Template' })
    if (idResult.isFailure()) return failure(new FindTemplateError({ error: idResult.value }))

    const created = Template.create({
      id: idResult.value.idValidated,
      projectId: raw.projectId,
      senderIdentityId: raw.senderIdentityId,
      name: raw.name,
      subject: raw.subject,
      html: raw.html,
      text: raw.text,
      createdAt: new Date(raw.createdAt)
    })
    if (created.isFailure()) return failure(new FindTemplateError({ error: created.value }))

    return success(created.value)
  }

  public async invalidate(input: { templateId: string; projectId: string }): Promise<void> {
    /*
     * Fire-and-forget: nothing writes a Template today (seed only), so this method has no caller
     * yet — included for symmetry with SenderIdentityCacheProvider, ready for whenever Template
     * gets a write path. A failed cache delete just means the stale value survives until its own
     * TTL expires, not incorrect data loss.
     */
    await this.cacheInvalidator.delete({ key: `${input.projectId}-${input.templateId}`, namespace: CACHE_NAMESPACE })
  }
}
