import { type Either } from '@ruguin/utils'

import { type FindTemplateError } from '../errors/find-template.error'
import { type Template } from '../models/template.model'

export const TEMPLATE_CACHE_PROVIDER = Symbol('TEMPLATE_CACHE_PROVIDER')

export interface TemplateCacheProvider {
  get(input: { templateId: string; projectId: string }): Promise<Either<FindTemplateError, Template | null>>
  invalidate(input: { templateId: string; projectId: string }): Promise<void>
}
