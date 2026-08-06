import { z } from 'zod'

export const RegisterSenderIdentityBodySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[^\r\n<>,;:"@\\]+$/, 'name must not contain control characters or email-header-unsafe characters'),
    email: z.email()
  })
  .strict()

export type RegisterSenderIdentityBody = z.infer<typeof RegisterSenderIdentityBodySchema>
