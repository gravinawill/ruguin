import { Module } from '@nestjs/common'

import { SES_IDENTITY_PROVIDER } from './domain/contracts/providers/ses-identity.provider'
import { SENDER_IDENTITY_REPOSITORY } from './domain/contracts/repositories/sender-identity.repository'
import { SENDER_IDENTITY_CACHE_PROVIDER } from './domain/contracts/sender-identity-cache.provider'
import { AwsSesIdentityProvider } from './infrastructure/aws/ses-identity.provider'
import { sesV2ClientProvider } from './infrastructure/aws/ses-v2-client.provider'
import { SenderIdentityCacheProvider } from './infrastructure/cache/sender-identity-cache.provider'
import { SenderIdentityRepository } from './infrastructure/database/prisma/sender-identity.repository'

@Module({
  providers: [
    SenderIdentityRepository,
    { provide: SENDER_IDENTITY_REPOSITORY, useExisting: SenderIdentityRepository },
    sesV2ClientProvider,
    AwsSesIdentityProvider,
    { provide: SES_IDENTITY_PROVIDER, useExisting: AwsSesIdentityProvider },
    SenderIdentityCacheProvider,
    { provide: SENDER_IDENTITY_CACHE_PROVIDER, useExisting: SenderIdentityCacheProvider }
  ],
  exports: [SENDER_IDENTITY_REPOSITORY, SES_IDENTITY_PROVIDER, SENDER_IDENTITY_CACHE_PROVIDER]
})
export class SenderIdentitiesModule {}
