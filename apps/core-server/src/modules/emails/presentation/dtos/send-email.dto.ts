import { z } from 'zod'

const SendEmailWithTemplateSchema = z.object({
  from: z.email(),
  to: z.email(),
  templateId: z.uuid(),
  variables: z.record(z.string(), z.string()).default({})
})

const SendEmailWithContentSchema = z.object({
  from: z.email(),
  to: z.email(),
  subject: z.string().min(1),
  html: z.string().min(1)
})

export const SendEmailBodySchema = z.union([SendEmailWithTemplateSchema, SendEmailWithContentSchema])

export type SendEmailBody = z.infer<typeof SendEmailBodySchema>
