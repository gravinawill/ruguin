import { type Either } from '@ruguin/utils'

import { type FindOrganizationError } from '../errors/find-organization.error'
import { type Organization } from '../models/organization.model'

export const ORGANIZATION_LOOKUP_PROVIDER = Symbol('ORGANIZATION_LOOKUP_PROVIDER')

export interface OrganizationLookupProvider {
  findById(input: {
    organizationId: string
  }): Promise<Either<FindOrganizationError, { organization: Organization | null }>>
}
