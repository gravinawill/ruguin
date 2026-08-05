import { Module } from '@nestjs/common'

import { PROJECT_LOOKUP_PROVIDER } from './domain/contracts/project-lookup.provider'
import { ProjectRepository } from './infrastructure/database/prisma/project.repository'

@Module({
  providers: [ProjectRepository, { provide: PROJECT_LOOKUP_PROVIDER, useExisting: ProjectRepository }],
  exports: [PROJECT_LOOKUP_PROVIDER]
})
export class ProjectsModule {}
