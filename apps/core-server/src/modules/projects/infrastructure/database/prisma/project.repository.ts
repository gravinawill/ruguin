import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type ProjectLookupProvider } from '../../../domain/contracts/project-lookup.provider'
import { FindProjectError } from '../../../domain/errors/find-project.error'
import { InvalidProjectError } from '../../../domain/errors/invalid-project.error'
import { Project } from '../../../domain/models/project.model'

@Injectable()
export class ProjectRepository implements ProjectLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    organizationId: string
    name: string
    createdAt: Date
  }): Either<InvalidProjectError, Project> {
    const idResult = ID.validate({ id: row.id, modelName: 'Project' })
    if (idResult.isFailure()) return failure(new InvalidProjectError({ reason: idResult.value.message }))

    return Project.create({
      id: idResult.value.idValidated,
      organizationId: row.organizationId,
      name: row.name,
      createdAt: row.createdAt
    })
  }

  public async findById(input: { projectId: string }): Promise<Either<FindProjectError, { project: Project | null }>> {
    try {
      const row = await this.prisma.project.findUnique({ where: { id: input.projectId } })
      if (row === null) return success({ project: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindProjectError({ error: mapped.value }))

      return success({ project: mapped.value })
    } catch (error: unknown) {
      return failure(new FindProjectError({ error }))
    }
  }
}
