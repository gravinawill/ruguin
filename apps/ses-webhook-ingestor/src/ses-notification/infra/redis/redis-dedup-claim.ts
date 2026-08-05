import { Injectable } from '@nestjs/common'
import { type ICacheProvider, InjectCache } from '@ruguin/cache'
import { type BaseError } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type DedupClaimInput,
  type DedupClaimOutput,
  type DedupClaimPort,
  type ReleaseClaimInput
} from '../../domain/contracts/dedup-claim.port.ts'

/* KeyBuilder forbids ":" in namespace segments (packages/cache/src/infra/key-builder.ts). */
const NAMESPACE = 'ses-webhook-ingestor-dedup'

@Injectable()
export class RedisDedupClaim implements DedupClaimPort {
  constructor(@InjectCache() private readonly cache: ICacheProvider) {}

  public async claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>> {
    const result = await this.cache.setIfNotExists({
      key: input.key,
      namespace: NAMESPACE,
      value: true,
      ttlInMs: input.ttlInMs
    })

    if (result.isFailure()) return failure(result.value)

    return success({ claimed: result.value.stored })
  }

  public async release(input: ReleaseClaimInput): Promise<Either<BaseError, void>> {
    const result = await this.cache.delete({ key: input.key, namespace: NAMESPACE })

    if (result.isFailure()) return failure(result.value)

    return success(undefined)
  }
}
