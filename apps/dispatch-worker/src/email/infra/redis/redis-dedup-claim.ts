import { Injectable } from '@nestjs/common'
import { type ICacheProvider, InjectCache } from '@ruguin/cache'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type DedupClaimInput,
  type DedupClaimOutput,
  type DedupClaimPort
} from '../../application/providers/dedup-claim.port.ts'

const NAMESPACE = 'dispatch-worker:dedup'

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
}
