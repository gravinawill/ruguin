import { Injectable } from '@nestjs/common'
import { ID } from '@ruguin/shared-domain'
import { type Either, failure, success } from '@ruguin/utils'

import { PrismaService } from '../../../../../shared/infrastructure/database/prisma/prisma.service'
import { type TemplateLookupProvider } from '../../../domain/contracts/template-lookup.provider'
import { FindTemplateError } from '../../../domain/errors/find-template.error'
import { InvalidTemplateError } from '../../../domain/errors/invalid-template.error'
import { Template } from '../../../domain/models/template.model'

@Injectable()
export class TemplateRepository implements TemplateLookupProvider {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string
    projectId: string
    senderIdentityId: string
    name: string
    subject: string
    html: string
    createdAt: Date
  }): Either<InvalidTemplateError, Template> {
    const idResult = ID.validate({ id: row.id, modelName: 'Template' })
    if (idResult.isFailure()) return failure(new InvalidTemplateError({ reason: idResult.value.message }))

    return Template.create({
      id: idResult.value.idValidated,
      projectId: row.projectId,
      senderIdentityId: row.senderIdentityId,
      name: row.name,
      subject: row.subject,
      html: row.html,
      createdAt: row.createdAt
    })
  }

  public async findByIdAndProjectId(input: {
    templateId: string
    projectId: string
  }): Promise<Either<FindTemplateError, { template: Template | null }>> {
    try {
      /*
       * Scoped by BOTH columns in the query itself — never fetched by id alone and filtered after,
       * which would make the isolation check a runtime `if` instead of a query-shape guarantee.
       */
      const row = await this.prisma.template.findFirst({ where: { id: input.templateId, projectId: input.projectId } })
      if (row === null) return success({ template: null })

      const mapped = this.toDomain(row)
      if (mapped.isFailure()) return failure(new FindTemplateError({ error: mapped.value }))

      return success({ template: mapped.value })
    } catch (error: unknown) {
      return failure(new FindTemplateError({ error }))
    }
  }
}
