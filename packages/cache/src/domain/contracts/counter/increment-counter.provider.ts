import { type Either } from '@ruguin/utils'

import { type CacheOperationError } from '../../errors'

export namespace IncrementCounterProviderDTO {
  export type Input = Readonly<{
    key: string
    namespace: string
    by?: number

    /*
     * The lifetime of the whole counting window, applied only when this call creates the
     * counter. It is deliberately not "the TTL of this write": passing it on every increment
     * does not push the expiry out, so the counter resets a fixed windowInMs after the *first*
     * increment regardless of how much traffic follows. That is what a fixed-window rate
     * limiter needs; a caller who reads it as a sliding TTL will see the count reset at what
     * look like arbitrary moments.
     */
    windowInMs?: number
  }>

  export type OutputError = Readonly<CacheOperationError>
  export type OutputSuccess = Readonly<{ value: number }>

  export type Output = Promise<Either<OutputError, OutputSuccess>>
}

export interface IIncrementCounterProvider {
  increment(input: IncrementCounterProviderDTO.Input): IncrementCounterProviderDTO.Output
}
