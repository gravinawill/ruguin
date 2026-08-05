import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'

import { ApiKeyAuthGuard } from '../../../api-keys/infrastructure/http/api-key-auth.guard'
import { type AuthenticatedTenant } from '../../../api-keys/infrastructure/http/authenticated-tenant'
import { AuthenticatedTenantParameter } from '../../../api-keys/infrastructure/http/authenticated-tenant.decorator'
import { SenderIdentityService } from '../../application/services/sender-identity.service'
import { InvalidRegisterSenderIdentityRequestError } from '../../domain/errors/invalid-register-sender-identity-request.error'
import { type SenderIdentity } from '../../domain/models/sender-identity.model'
import { RegisterSenderIdentityBodySchema } from '../dtos/register-sender-identity.dto'

type SenderIdentityResponse = { id: string; name: string; email: string; domain: string; verifiedAt: string | null }

function toResponse(senderIdentity: SenderIdentity): SenderIdentityResponse {
  return {
    id: senderIdentity.id.toString(),
    name: senderIdentity.name,
    email: senderIdentity.email,
    domain: senderIdentity.domain,
    verifiedAt: senderIdentity.verifiedAt?.toISOString() ?? null
  }
}

@Controller()
@UseGuards(ApiKeyAuthGuard)
export class SenderIdentityController {
  constructor(private readonly senderIdentityService: SenderIdentityService) {}

  @Post()
  @HttpCode(201)
  public async register(
    @Body() rawBody: unknown,
    @AuthenticatedTenantParameter() tenant: AuthenticatedTenant
  ): Promise<SenderIdentityResponse> {
    const parsed = RegisterSenderIdentityBodySchema.safeParse(rawBody)
    if (!parsed.success) throw new InvalidRegisterSenderIdentityRequestError({ issues: parsed.error.issues })

    const result = await this.senderIdentityService.register({ ...parsed.data, projectId: tenant.projectId })
    if (result.isFailure()) throw result.value

    return toResponse(result.value)
  }

  @Get()
  public async list(@AuthenticatedTenantParameter() tenant: AuthenticatedTenant): Promise<SenderIdentityResponse[]> {
    const result = await this.senderIdentityService.list({ projectId: tenant.projectId })
    if (result.isFailure()) throw result.value

    return result.value.map((senderIdentity) => toResponse(senderIdentity))
  }
}
