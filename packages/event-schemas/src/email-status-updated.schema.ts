import { z } from 'zod'

export const EMAIL_STATUS_UPDATED_TOPIC = 'email.status.updated'
export const EMAIL_STATUS_UPDATED_DLQ_TOPIC = 'email.status.updated.dlq'

export const EmailStatusUpdatedStatus = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  BOUNCED: 'bounced',
  COMPLAINED: 'complained',
  FAILED: 'failed'
} as const

export const EmailStatusUpdatedPayloadSchema = z.object({
  emailId: z.uuid(),
  status: z.enum(EmailStatusUpdatedStatus),
  sesMessageId: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional()
})

export type EmailStatusUpdatedPayload = z.infer<typeof EmailStatusUpdatedPayloadSchema>
