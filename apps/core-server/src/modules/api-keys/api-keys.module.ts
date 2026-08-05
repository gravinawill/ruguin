import { Module } from '@nestjs/common'

import { ProjectsModule } from '../projects/projects.module'

import { API_KEY_REPOSITORY } from './domain/contracts/api-key.repository'
import { ApiKeyRepository } from './infrastructure/database/prisma/api-key.repository'
import { ApiKeyAuthGuard } from './infrastructure/http/api-key-auth.guard'

@Module({
  imports: [ProjectsModule],
  providers: [ApiKeyRepository, { provide: API_KEY_REPOSITORY, useExisting: ApiKeyRepository }, ApiKeyAuthGuard],
  exports: [ApiKeyAuthGuard]
})
export class ApiKeysModule {}
