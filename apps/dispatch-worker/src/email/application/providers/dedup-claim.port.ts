import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const DEDUP_CLAIM_PROVIDER = Symbol('DEDUP_CLAIM_PROVIDER')

export type DedupClaimInput = Readonly<{ key: string; ttlInMs: number }>
export type DedupClaimOutput = Readonly<{ claimed: boolean }>
export type ReleaseClaimInput = Readonly<{ key: string }>

export interface DedupClaimPort {
  claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>>
  /*
   * Frees a claim early instead of waiting out its TTL. SendEmailUseCase calls this whenever it
   * is about to report failure for an already-claimed attempt (a downstream Kafka publish failed)
   * — Kafka will redeliver that message, and without releasing the claim first, the redelivered
   * attempt would be silently treated as a duplicate for the rest of the TTL window instead of
   * actually retrying the failed step.
   */
  release(input: ReleaseClaimInput): Promise<Either<BaseError, void>>
}
