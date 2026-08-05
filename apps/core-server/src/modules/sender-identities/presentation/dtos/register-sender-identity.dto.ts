import { z } from 'zod'

export const RegisterSenderIdentityBodySchema = z
  .object({
    name: z.string().min(1),
    email: z.email()
  })
  .strict()

export type RegisterSenderIdentityBody = z.infer<typeof RegisterSenderIdentityBodySchema>
