import { type Either } from '@ruguin/utils'

import { type FindProjectError } from '../errors/find-project.error'
import { type Project } from '../models/project.model'

export const PROJECT_LOOKUP_PROVIDER = Symbol('PROJECT_LOOKUP_PROVIDER')

export interface ProjectLookupProvider {
  findById(input: { projectId: string }): Promise<Either<FindProjectError, { project: Project | null }>>
}
