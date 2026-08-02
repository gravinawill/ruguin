import { type BaseError } from '@ruguin/ddd-kernel'
import { type Either } from '@ruguin/utils'

export const RATE_LIMITER_PROVIDER = Symbol('RATE_LIMITER_PROVIDER')

export type RateLimiterCheckInput = Readonly<{ key: string; limit: number; windowInMs: number }>
export type RateLimiterCheckOutput = Readonly<{ allowed: boolean }>

export interface RateLimiterPort {
  check(input: RateLimiterCheckInput): Promise<Either<BaseError, RateLimiterCheckOutput>>
}
