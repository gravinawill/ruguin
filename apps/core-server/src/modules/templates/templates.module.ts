import { Module } from '@nestjs/common'

import { TEMPLATE_LOOKUP_PROVIDER } from './domain/contracts/template-lookup.provider'
import { TemplateRepository } from './infrastructure/database/prisma/template.repository'

@Module({
  providers: [TemplateRepository, { provide: TEMPLATE_LOOKUP_PROVIDER, useExisting: TemplateRepository }],
  exports: [TEMPLATE_LOOKUP_PROVIDER]
})
export class TemplatesModule {}
