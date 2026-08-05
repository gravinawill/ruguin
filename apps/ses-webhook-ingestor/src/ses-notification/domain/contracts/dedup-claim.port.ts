import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const DEDUP_CLAIM_PROVIDER = Symbol('DEDUP_CLAIM_PROVIDER')

export type DedupClaimInput = Readonly<{ key: string; ttlInMs: number }>
export type DedupClaimOutput = Readonly<{ claimed: boolean }>
export type ConfirmClaimInput = Readonly<{ key: string; ttlInMs: number }>
export type ReleaseClaimInput = Readonly<{ key: string }>

export interface DedupClaimPort {
  claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>>
  /*
   * Extends an already-owned claim from its short in-flight lease to the full dedup TTL, once the
   * caller has confirmed the outcome is durably handled. Called only after claim() reported
   * claimed: true for this same key — never a compare-and-swap, a plain overwrite is correct.
   */
  confirm(input: ConfirmClaimInput): Promise<Either<BaseError, void>>
  /*
   * Frees a claim early when IngestSesNotificationUseCase is about to report failure for an
   * already-claimed EventBridge event id (a downstream Kafka publish failed) — same reasoning as
   * apps/dispatch-worker/src/email/application/providers/dedup-claim.port.ts's release().
   */
  release(input: ReleaseClaimInput): Promise<Either<BaseError, void>>
}
