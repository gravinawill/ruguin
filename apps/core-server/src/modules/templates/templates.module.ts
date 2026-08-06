import { Module } from '@nestjs/common'

import { TEMPLATE_CACHE_PROVIDER } from './domain/contracts/template-cache.provider'
import { TEMPLATE_LOOKUP_PROVIDER } from './domain/contracts/template-lookup.provider'
import { TemplateCacheProvider } from './infrastructure/cache/template-cache.provider'
import { TemplateRepository } from './infrastructure/database/prisma/template.repository'

@Module({
  providers: [
    TemplateRepository,
    { provide: TEMPLATE_LOOKUP_PROVIDER, useExisting: TemplateRepository },
    TemplateCacheProvider,
    { provide: TEMPLATE_CACHE_PROVIDER, useExisting: TemplateCacheProvider }
  ],
  exports: [TEMPLATE_LOOKUP_PROVIDER, TEMPLATE_CACHE_PROVIDER]
})
export class TemplatesModule {}
