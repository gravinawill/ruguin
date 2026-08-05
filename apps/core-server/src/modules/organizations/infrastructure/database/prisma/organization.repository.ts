import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type OrganizationLookupProvider } from '../../../domain/contracts/organization-lookup.provider'
import { FindOrganizationError } from '../../../domain/errors/find-organization.error'
import { InvalidOrganizationError } from '../../../domain/errors/invalid-organization.error'
import { Organization } from '../../../domain/models/organization.model'

@Injectable()
export class OrganizationRepository implements OrganizationLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: { id: string; name: string; createdAt: Date }): Either<InvalidOrganizationError, Organization> {
    const idResult = ID.validate({ id: row.id, modelName: 'Organization' })
    if (idResult.isFailure()) return failure(new InvalidOrganizationError({ reason: idResult.value.message }))

    return Organization.create({ id: idResult.value.idValidated, name: row.name, createdAt: row.createdAt })
  }

  public async findById(input: {
    organizationId: string
  }): Promise<Either<FindOrganizationError, { organization: Organization | null }>> {
    try {
      const row = await this.prisma.organization.findUnique({ where: { id: input.organizationId } })
      if (row === null) return success({ organization: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindOrganizationError({ error: mapped.value }))

      return success({ organization: mapped.value })
    } catch (error: unknown) {
      return failure(new FindOrganizationError({ error }))
    }
  }
}
