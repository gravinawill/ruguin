import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const DEDUP_CLAIM_PROVIDER = Symbol('DEDUP_CLAIM_PROVIDER')

export type DedupClaimInput = Readonly<{ key: string; ttlInMs: number }>
export type DedupClaimOutput = Readonly<{ claimed: boolean }>

export interface DedupClaimPort {
  claim(input: DedupClaimInput): Promise<Either<BaseError, DedupClaimOutput>>
}
