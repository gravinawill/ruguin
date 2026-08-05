import { Module } from '@nestjs/common'

import { SES_IDENTITY_PROVIDER } from './domain/contracts/providers/ses-identity.provider'
import { SENDER_IDENTITY_REPOSITORY } from './domain/contracts/repositories/sender-identity.repository'
import { AwsSesIdentityProvider } from './infrastructure/aws/ses-identity.provider'
import { sesV2ClientProvider } from './infrastructure/aws/ses-v2-client.provider'
import { SenderIdentityRepository } from './infrastructure/database/prisma/sender-identity.repository'

@Module({
  providers: [
    SenderIdentityRepository,
    { provide: SENDER_IDENTITY_REPOSITORY, useExisting: SenderIdentityRepository },
    sesV2ClientProvider,
    AwsSesIdentityProvider,
    { provide: SES_IDENTITY_PROVIDER, useExisting: AwsSesIdentityProvider }
  ],
  exports: [SENDER_IDENTITY_REPOSITORY, SES_IDENTITY_PROVIDER]
})
export class SenderIdentitiesModule {}
