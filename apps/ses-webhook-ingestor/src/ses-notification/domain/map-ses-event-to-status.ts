import { EmailStatusUpdatedStatus, type SesBounceType } from '@ruguin/event-schemas'

import { type SesEventDetail } from '../presentation/dto/eventbridge-ses-notification.schema.ts'

export type MappedSesStatus = Readonly<{
  status: (typeof EmailStatusUpdatedStatus)['DELIVERED' | 'BOUNCED' | 'COMPLAINED']
  bounceType?: (typeof SesBounceType)[keyof typeof SesBounceType]
}>

export function mapSesEventToStatus(detail: SesEventDetail): MappedSesStatus {
  if (detail.eventType === 'Bounce')
    return { status: EmailStatusUpdatedStatus.BOUNCED, bounceType: detail.bounce.bounceType }
  if (detail.eventType === 'Delivery') return { status: EmailStatusUpdatedStatus.DELIVERED }
  return { status: EmailStatusUpdatedStatus.COMPLAINED }
}
