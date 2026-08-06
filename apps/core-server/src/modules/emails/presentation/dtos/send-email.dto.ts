import { z } from 'zod'

export const SendEmailBodySchema = z
  .object({
    to: z.email(),
    templateId: z.uuid(),
    variables: z.record(z.string(), z.string()).default({})
  })
  .strict()

export type SendEmailBody = z.infer<typeof SendEmailBodySchema>
