import { type Either } from '@ruguin/utils'

import { type FindApiKeyError } from '../errors/find-api-key.error'
import { type ApiKey } from '../models/api-key.model'

export const API_KEY_REPOSITORY = Symbol('API_KEY_REPOSITORY')

export interface ApiKeyRepository {
  findActiveByHashedKey(input: { hashedKey: string }): Promise<Either<FindApiKeyError, { apiKey: ApiKey | null }>>
}
