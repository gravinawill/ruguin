import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import { type AuthenticatedRequest, type AuthenticatedTenant } from './authenticated-tenant'

export const AuthenticatedTenantParameter = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedTenant => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()

    /*
     * ApiKeyAuthGuard always runs first and always sets this or throws — an undefined tenant here
     * means the guard was skipped, which is a wiring bug in the controller, not a request to reject.
     */
    if (request.authenticatedTenant === undefined) {
      throw new Error('AuthenticatedTenantParameter used on a route with no ApiKeyAuthGuard.')
    }

    return request.authenticatedTenant
  }
)
