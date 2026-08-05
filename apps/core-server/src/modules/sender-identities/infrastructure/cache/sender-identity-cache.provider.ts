import { Inject, Injectable } from '@nestjs/common'
import {
  DELETE_CACHE_PROVIDER,
  GET_OR_SET_CACHE_PROVIDER,
  type IDeleteCacheProvider,
  type IGetOrSetCacheProvider
} from '@ruguin/cache'
import { coreServerENV } from '@ruguin/env'
import { type Either, failure, success } from '@ruguin/utils'

import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import { type SenderIdentityCacheProvider as SenderIdentityCacheProviderContract } from '../../domain/contracts/sender-identity-cache.provider'
import { type FindSenderIdentityError } from '../../domain/errors/find-sender-identity.error'
import { type SenderIdentity } from '../../domain/models/sender-identity.model'

// KeyBuilder.validateSegment forbids ':' in namespace/key segments — see packages/cache/src/infra/key-builder.ts.
const CACHE_NAMESPACE = 'core-server-sender-identity'

@Injectable()
export class SenderIdentityCacheProvider implements SenderIdentityCacheProviderContract {
  constructor(
    @Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository,
    @Inject(GET_OR_SET_CACHE_PROVIDER) private readonly cache: IGetOrSetCacheProvider,
    @Inject(DELETE_CACHE_PROVIDER) private readonly cacheInvalidator: IDeleteCacheProvider
  ) {}

  public async get(input: {
    senderIdentityId: string
  }): Promise<Either<FindSenderIdentityError, SenderIdentity | null>> {
    const cached = await this.cache.getOrSet<SenderIdentity, FindSenderIdentityError>({
      key: input.senderIdentityId,
      namespace: CACHE_NAMESPACE,
      ttlInMs: coreServerENV.SENDER_IDENTITY_CACHE_TTL_IN_SECONDS * 1000,
      loader: async () => {
        const result = await this.repository.findById({ id: input.senderIdentityId })
        if (result.isFailure()) return failure(result.value)
        return success(result.value.senderIdentity)
      }
    })

    if (cached.isFailure()) return failure(cached.value)
    return success(cached.value.value)
  }

  public async invalidate(input: { senderIdentityId: string }): Promise<void> {
    /*
     * Fire-and-forget: Postgres (via markVerified, Task 7) is already the source of truth by the
     * time this runs. A failed cache delete just means the stale value survives until its own TTL
     * expires — not incorrect data loss — so it must not fail whatever caller triggered it.
     */
    await this.cacheInvalidator.delete({ key: input.senderIdentityId, namespace: CACHE_NAMESPACE })
  }
}
