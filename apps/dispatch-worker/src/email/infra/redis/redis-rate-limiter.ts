import { Injectable } from '@nestjs/common'
import { type ICacheProvider, InjectCache } from '@ruguin/cache'
import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either, failure, success } from '@ruguin/utils'

import {
  type RateLimiterCheckInput,
  type RateLimiterCheckOutput,
  type RateLimiterPort
} from '../../application/providers/rate-limiter.port.ts'

/* KeyBuilder forbids ":" in namespace segments (packages/cache/src/infra/key-builder.ts). */
const NAMESPACE = 'dispatch-worker-rate-limit'

@Injectable()
export class RedisRateLimiter implements RateLimiterPort {
  constructor(@InjectCache() private readonly cache: ICacheProvider) {}

  public async check(input: RateLimiterCheckInput): Promise<Either<BaseError, RateLimiterCheckOutput>> {
    const result = await this.cache.increment({ key: input.key, namespace: NAMESPACE, windowInMs: input.windowInMs })

    if (result.isFailure()) return failure(result.value)

    return success({ allowed: result.value.value <= input.limit })
  }
}
