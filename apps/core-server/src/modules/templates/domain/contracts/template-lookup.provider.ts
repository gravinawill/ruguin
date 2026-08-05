import { type Either } from '@ruguin/utils'

import { type FindTemplateError } from '../errors/find-template.error'
import { type Template } from '../models/template.model'

export const TEMPLATE_LOOKUP_PROVIDER = Symbol('TEMPLATE_LOOKUP_PROVIDER')

export interface TemplateLookupProvider {
  findByIdAndProjectId(input: {
    templateId: string
    projectId: string
  }): Promise<Either<FindTemplateError, { template: Template | null }>>
}
