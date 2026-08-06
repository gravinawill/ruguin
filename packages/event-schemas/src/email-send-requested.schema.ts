import { z } from 'zod'

export const EMAIL_SEND_REQUESTED_TOPIC = 'email.send.requested'
export const EMAIL_SEND_REQUESTED_RETRY_TOPIC = 'email.send.requested.retry'
export const EMAIL_SEND_REQUESTED_DLQ_TOPIC = 'email.send.requested.dlq'

export const EmailSendRequestedPayloadSchema = z.object({
  emailId: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  from: z.email(),
  fromName: z.string().min(1).optional(),
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  idempotencyKey: z.string().min(1).optional()
})

export type EmailSendRequestedPayload = z.infer<typeof EmailSendRequestedPayloadSchema>
