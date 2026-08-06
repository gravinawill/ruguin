import { type BaseError } from '@ruguin/shared-domain'
import { type Either } from '@ruguin/utils'

import { type Template } from '../models/template.model'

export const TEMPLATE_CACHE_PROVIDER = Symbol('TEMPLATE_CACHE_PROVIDER')

export interface TemplateCacheProvider {
  get(input: { templateId: string; projectId: string }): Promise<Either<BaseError, Template | null>>
  invalidate(input: { templateId: string }): Promise<void>
}
