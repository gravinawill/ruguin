import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type ApiKeyRepository as ApiKeyRepositoryContract } from '../../../domain/contracts/api-key.repository'
import { FindApiKeyError } from '../../../domain/errors/find-api-key.error'
import { InvalidApiKeyError } from '../../../domain/errors/invalid-api-key.error'
import { ApiKey } from '../../../domain/models/api-key.model'

@Injectable()
export class ApiKeyRepository implements ApiKeyRepositoryContract {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
    hashedKey: string
    revokedAt: Date | null
    createdAt: Date
  }): Either<InvalidApiKeyError, ApiKey> {
    const idResult = ID.validate({ id: row.id, modelName: 'ApiKey' })
    if (idResult.isFailure()) return failure(new InvalidApiKeyError({ reason: idResult.value.message }))

    return ApiKey.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      hashedKey: row.hashedKey,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt
    })
  }

  public async findActiveByHashedKey(input: {
    hashedKey: string
  }): Promise<Either<FindApiKeyError, { apiKey: ApiKey | null }>> {
    try {
      /*
       * revokedAt filtered in the query itself: a revoked key must never even reach toDomain,
       * let alone be handed back as "found".
       */
      const row = await this.prisma.apiKey.findFirst({ where: { hashedKey: input.hashedKey, revokedAt: null } })
      if (row === null) return success({ apiKey: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindApiKeyError({ error: mapped.value }))

      return success({ apiKey: mapped.value })
    } catch (error: unknown) {
      return failure(new FindApiKeyError({ error }))
    }
  }
}
