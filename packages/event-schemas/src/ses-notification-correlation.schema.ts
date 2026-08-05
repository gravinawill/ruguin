import { z } from 'zod'

import { EmailStatusUpdatedStatus, SesBounceType } from './email-status-updated.schema.ts'

export const SES_NOTIFICATION_CORRELATION_RETRY_TOPIC = 'ses.notification.correlation.retry'
export const SES_NOTIFICATION_CORRELATION_DLQ_TOPIC = 'ses.notification.correlation.dlq'
export const SES_NOTIFICATION_MALFORMED_DLQ_TOPIC = 'ses.notification.malformed.dlq'

/*
 * Only the three statuses ses-webhook-ingestor can ever produce — sent/failed never flow through
 * this retry loop, so admitting them here would let a producer bug schedule a nonsensical retry.
 */
export const SesNotificationCorrelationStatus = {
  DELIVERED: EmailStatusUpdatedStatus.DELIVERED,
  BOUNCED: EmailStatusUpdatedStatus.BOUNCED,
  COMPLAINED: EmailStatusUpdatedStatus.COMPLAINED
} as const

export const SesNotificationCorrelationPendingPayloadSchema = z.object({
  sesMessageId: z.string().min(1),
  status: z.enum(SesNotificationCorrelationStatus),
  bounceType: z.enum(SesBounceType).optional()
})

export type SesNotificationCorrelationPendingPayload = z.infer<typeof SesNotificationCorrelationPendingPayloadSchema>
