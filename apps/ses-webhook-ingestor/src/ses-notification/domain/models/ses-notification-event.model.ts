import { EmailStatusUpdatedStatus, type SesBounceType } from '@ruguin/event-schemas'
import { type Either, failure, success } from '@ruguin/utils'

import { InvalidSesNotificationEventError } from '../errors/invalid-ses-notification-event.error.ts'

export type SesNotificationEventType = 'Delivery' | 'Bounce' | 'Complaint'
export type SesNotificationStatus = (typeof EmailStatusUpdatedStatus)['DELIVERED' | 'BOUNCED' | 'COMPLAINED']
type BounceTypeValue = (typeof SesBounceType)[keyof typeof SesBounceType]

export type CreateSesNotificationEventInput = Readonly<{
  sesMessageId: string
  eventType: SesNotificationEventType
  bounceType?: BounceTypeValue
}>

/*
 * The domain model this bounded context builds around: a validated SES notification, stripped of
 * every EventBridge/transport concern (envelope id, source, detail-type). eventType -> status is a
 * domain rule (which internal status a given SES event type produces), so it belongs in create(),
 * not in a separate presentation-facing mapper.
 */
export class SesNotificationEvent {
  public readonly sesMessageId: string
  public readonly status: SesNotificationStatus
  public readonly bounceType?: BounceTypeValue

  /*
   * `| undefined` on the optional field, not just `?`: under exactOptionalPropertyTypes create()
   * cannot narrow `bounceType` out of the Bounce branch (the guard above is a conjunction, which
   * TypeScript does not decompose), so it hands the value over still typed as possibly undefined.
   */
  private constructor(input: {
    sesMessageId: string
    status: SesNotificationStatus
    bounceType?: BounceTypeValue | undefined
  }) {
    this.sesMessageId = input.sesMessageId
    this.status = input.status
    if (input.bounceType !== undefined) this.bounceType = input.bounceType
    Object.freeze(this)
  }

  public static create(
    input: CreateSesNotificationEventInput
  ): Either<InvalidSesNotificationEventError, SesNotificationEvent> {
    const sesMessageId = input.sesMessageId.trim()
    const { eventType, bounceType } = input

    if (sesMessageId.length === 0) {
      return failure(new InvalidSesNotificationEventError({ message: 'sesMessageId must not be empty' }))
    }

    if (eventType === 'Bounce' && bounceType === undefined) {
      return failure(
        new InvalidSesNotificationEventError({ message: 'bounceType is required when eventType is Bounce' })
      )
    }

    if (eventType !== 'Bounce' && bounceType !== undefined) {
      return failure(
        new InvalidSesNotificationEventError({ message: 'bounceType is only allowed when eventType is Bounce' })
      )
    }

    if (eventType === 'Bounce') {
      return success(new SesNotificationEvent({ sesMessageId, status: EmailStatusUpdatedStatus.BOUNCED, bounceType }))
    }

    if (eventType === 'Delivery') {
      return success(new SesNotificationEvent({ sesMessageId, status: EmailStatusUpdatedStatus.DELIVERED }))
    }

    return success(new SesNotificationEvent({ sesMessageId, status: EmailStatusUpdatedStatus.COMPLAINED }))
  }
}
