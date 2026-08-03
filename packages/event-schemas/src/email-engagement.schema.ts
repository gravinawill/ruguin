import { z } from 'zod'

export const EMAIL_ENGAGEMENT_TOPIC = 'email.engagement'
export const EMAIL_ENGAGEMENT_DLQ_TOPIC = 'email.engagement.dlq'

export const EmailEngagementType = {
  OPEN: 'open',
  CLICK: 'click'
} as const

export const EmailEngagementPayloadSchema = z.object({
  emailId: z.uuid(),
  type: z.enum(EmailEngagementType),
  occurredAt: z.iso.datetime()
})

export type EmailEngagementPayload = z.infer<typeof EmailEngagementPayloadSchema>
