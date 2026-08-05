import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common'

import { ApiKeyAuthGuard } from '../../../api-keys/infrastructure/http/api-key-auth.guard'
import { type AuthenticatedTenant } from '../../../api-keys/infrastructure/http/authenticated-tenant'
import { AuthenticatedTenantParameter } from '../../../api-keys/infrastructure/http/authenticated-tenant.decorator'
import { SendEmailService } from '../../application/services/send-email.service'
import { InvalidSendEmailRequestError } from '../../domain/errors/models/invalid-send-email-request.error'
import { SendEmailBodySchema } from '../dtos/send-email.dto'

@Controller()
@UseGuards(ApiKeyAuthGuard)
export class EmailController {
  constructor(private readonly sendEmailService: SendEmailService) {}

  @Post()
  @HttpCode(202)
  public async send(
    @Body() rawBody: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @AuthenticatedTenantParameter() tenant: AuthenticatedTenant
  ): Promise<{ id: string; status: 'queued' }> {
    const parsed = SendEmailBodySchema.safeParse(rawBody)
    if (!parsed.success) throw new InvalidSendEmailRequestError({ issues: parsed.error.issues })

    /*
     * `Idempotency-Key:` with no value arrives as '' (never undefined), and '' is not a key: it
     * would flow through the use case's `?? null` untouched, past Email.create (which does not
     * validate it), and only die at the outbox payload's z.string().min(1) as a 500. Absent is
     * what a blank header means, so it is normalized to absent here, at the boundary that owns
     * header semantics.
     */
    const hasIdempotencyKey = idempotencyKey !== undefined && idempotencyKey.trim() !== ''

    const result = await this.sendEmailService.execute({
      ...parsed.data,
      projectId: tenant.projectId,
      organizationId: tenant.organizationId,
      ...(hasIdempotencyKey && { idempotencyKey })
    })

    if (result.isFailure()) throw result.value

    return { id: result.value.id.toString(), status: 'queued' }
  }
}
