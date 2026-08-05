import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

export const CORRELATION_PROVIDER = Symbol('CORRELATION_PROVIDER')

export type UpsertCorrelationInput = Readonly<{ sesMessageId: string; emailId: string }>
export type LookupCorrelationInput = Readonly<{ sesMessageId: string }>
export type LookupCorrelationOutput = Readonly<{ emailId: string }> | null

export interface CorrelationPort {
  /*
   * Idempotent by design (ON CONFLICT DO NOTHING semantics) — dispatch-worker's email.status.updated
   * sent event is at-least-once, so this may run more than once for the same sesMessageId.
   */
  upsert(input: UpsertCorrelationInput): Promise<Either<BaseError, void>>
  lookup(input: LookupCorrelationInput): Promise<Either<BaseError, LookupCorrelationOutput>>
}
