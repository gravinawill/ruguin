import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const DEDUP_CLAIM_PROVIDER = Symbol('DEDUP_CLAIM_PROVIDER')

export type DedupClaimInput = Readonly<{ key: string; ttlInMs: number }>
export type DedupClaimOutput = Readonly<{ claimed: boolean }>
export type ReleaseClaimInput = Readonly<{ key: string }>

export interface DedupClaimPort {
  claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>>
  /*
   * Frees a claim early when IngestSesNotificationUseCase is about to report failure for an
   * already-claimed EventBridge event id (a downstream Kafka publish failed) — same reasoning as
   * apps/dispatch-worker/src/email/application/providers/dedup-claim.port.ts's release().
   */
  release(input: ReleaseClaimInput): Promise<Either<BaseError, void>>
}
