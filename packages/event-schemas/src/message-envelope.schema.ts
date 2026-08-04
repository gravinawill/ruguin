import { z } from 'zod'

export function createMessageEnvelopeSchema<T extends z.ZodType>(payloadSchema: T) {
  return z.object({
    eventId: z.uuid(),
    name: z.string().min(1),
    payload: payloadSchema
  })
}
