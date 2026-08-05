import { Module } from '@nestjs/common'

import { ORGANIZATION_LOOKUP_PROVIDER } from './domain/contracts/organization-lookup.provider'
import { OrganizationRepository } from './infrastructure/database/prisma/organization.repository'

@Module({
  providers: [OrganizationRepository, { provide: ORGANIZATION_LOOKUP_PROVIDER, useExisting: OrganizationRepository }],
  exports: [ORGANIZATION_LOOKUP_PROVIDER]
})
export class OrganizationsModule {}
