import { SesBounceType } from '@ruguin/event-schemas'
import { z } from 'zod'

const SesMailSchema = z.object({ messageId: z.string().min(1) })
const SesBounceDetailSchema = z.object({ bounceType: z.enum(SesBounceType) })

/*
 * A discriminated union, not one object with an optional `bounce` — SES only ever includes the
 * bounce object when eventType=Bounce, and making that structural (rather than "optional and
 * hope it's there") means the caller can hand SesNotificationEvent.create() a bounceType without
 * first guarding against a Bounce notification that carries no bounce detail; the type system
 * already rules that combination out.
 */
const SesEventDetailSchema = z.discriminatedUnion('eventType', [
  z.object({ eventType: z.literal('Bounce'), mail: SesMailSchema, bounce: SesBounceDetailSchema }),
  z.object({ eventType: z.literal('Delivery'), mail: SesMailSchema }),
  z.object({ eventType: z.literal('Complaint'), mail: SesMailSchema })
])

export const EventBridgeSesNotificationSchema = z.object({
  id: z.string().min(1),
  source: z.literal('aws.ses'),
  detail: SesEventDetailSchema
})

export type EventBridgeSesNotification = z.infer<typeof EventBridgeSesNotificationSchema>
