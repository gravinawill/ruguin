import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { GET_OR_SET_CACHE_PROVIDER, type IGetOrSetCacheProvider } from '@ruguin/cache'
import { coreServerENV } from '@ruguin/env'
import { type Either, failure, success } from '@ruguin/utils'

import {
  PROJECT_LOOKUP_PROVIDER,
  type ProjectLookupProvider
} from '../../../projects/domain/contracts/project-lookup.provider'
import { type FindProjectError } from '../../../projects/domain/errors/find-project.error'
import { API_KEY_REPOSITORY, type ApiKeyRepository } from '../../domain/contracts/api-key.repository'
import { ApiKeyUnauthorizedError } from '../../domain/errors/api-key-unauthorized.error'
import { type FindApiKeyError } from '../../domain/errors/find-api-key.error'
import { hashApiKey } from '../../domain/hash-api-key'

import { type AuthenticatedRequest, type AuthenticatedTenant } from './authenticated-tenant'

const BEARER_PREFIX = 'Bearer '
// KeyBuilder.validateSegment forbids ':' in namespace/key segments — see packages/cache/src/infra/key-builder.ts.
const CACHE_NAMESPACE = 'core-server-api-key'

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly apiKeyRepository: ApiKeyRepository,
    @Inject(PROJECT_LOOKUP_PROVIDER) private readonly projectLookup: ProjectLookupProvider,
    @Inject(GET_OR_SET_CACHE_PROVIDER) private readonly cache: IGetOrSetCacheProvider
  ) {}

  private async resolveTenant(
    hashedKey: string
  ): Promise<Either<FindApiKeyError | FindProjectError, AuthenticatedTenant | null>> {
    const apiKeyResult = await this.apiKeyRepository.findActiveByHashedKey({ hashedKey })
    if (apiKeyResult.isFailure()) return failure(apiKeyResult.value)
    if (apiKeyResult.value.apiKey === null) return success(null)

    const projectResult = await this.projectLookup.findById({ projectId: apiKeyResult.value.apiKey.projectId })
    if (projectResult.isFailure()) return failure(projectResult.value)
    if (projectResult.value.project === null) return success(null)

    /*
     * projectId comes from the API key's own FK, not project.id.toString(): the Project
     * aggregate's `id` is its own generated identity, decoupled in shape from the string the
     * caller used to look it up. Re-deriving it here would round-trip a value we already have.
     */
    return success({
      projectId: apiKeyResult.value.apiKey.projectId,
      organizationId: projectResult.value.project.organizationId
    })
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers.authorization

    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new ApiKeyUnauthorizedError({ reason: 'Missing or malformed Authorization header' })
    }

    const rawKey = header.slice(BEARER_PREFIX.length).trim()
    if (rawKey.length === 0) {
      throw new ApiKeyUnauthorizedError({ reason: 'Missing or malformed Authorization header' })
    }

    const hashedKey = hashApiKey({ rawKey })

    const cached = await this.cache.getOrSet<AuthenticatedTenant, FindApiKeyError | FindProjectError>({
      key: hashedKey,
      namespace: CACHE_NAMESPACE,
      ttlInMs: coreServerENV.API_KEY_CACHE_TTL_IN_SECONDS * 1000,
      loader: () => this.resolveTenant(hashedKey)
    })

    if (cached.isFailure()) throw cached.value
    if (cached.value.value === null) {
      throw new ApiKeyUnauthorizedError({ reason: 'Unknown or revoked API key' })
    }

    request.authenticatedTenant = cached.value.value

    return true
  }
}
