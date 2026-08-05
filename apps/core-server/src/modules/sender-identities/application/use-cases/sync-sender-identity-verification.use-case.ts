import { Inject, Injectable, Logger } from '@nestjs/common'

import { SES_IDENTITY_PROVIDER, type SesIdentityProvider } from '../../domain/contracts/providers/ses-identity.provider'
import {
  SENDER_IDENTITY_REPOSITORY,
  type SenderIdentityRepository
} from '../../domain/contracts/repositories/sender-identity.repository'
import {
  SENDER_IDENTITY_CACHE_PROVIDER,
  type SenderIdentityCacheProvider
} from '../../domain/contracts/sender-identity-cache.provider'

@Injectable()
export class SyncSenderIdentityVerificationUseCase {
  private readonly logger = new Logger(SyncSenderIdentityVerificationUseCase.name)

  constructor(
    @Inject(SENDER_IDENTITY_REPOSITORY) private readonly repository: SenderIdentityRepository,
    @Inject(SES_IDENTITY_PROVIDER) private readonly sesIdentityProvider: SesIdentityProvider,
    @Inject(SENDER_IDENTITY_CACHE_PROVIDER) private readonly cache: SenderIdentityCacheProvider
  ) {}

  public async execute(): Promise<void> {
    const unverified = await this.repository.findUnverified()
    if (unverified.isFailure()) {
      this.logger.warn(`Failed to list unverified sender identities: ${unverified.value.message}`)
      return
    }

    for (const senderIdentity of unverified.value.senderIdentities) {
      await this.syncOne(senderIdentity.id.toString(), senderIdentity.email)
    }
  }

  private async syncOne(id: string, email: string): Promise<void> {
    const status = await this.sesIdentityProvider.getVerificationStatus({ email })
    if (status.isFailure()) {
      /*
       * One identity's SES call failing (rate limit, transient network) must not stop the sweep —
       * the rest of the unverified batch still deserves its check this tick, and this one gets
       * retried automatically on the next.
       */
      this.logger.warn(`Failed to check SES verification status for ${email}: ${status.value.message}`)
      return
    }

    if (!status.value.verified) return

    const marked = await this.repository.markVerified({ id, verifiedAt: new Date() })
    if (marked.isFailure()) {
      this.logger.warn(`Verified with SES but failed to persist for sender identity ${id}: ${marked.value.message}`)
      return
    }

    await this.cache.invalidate({ senderIdentityId: id })
    this.logger.log(`Sender identity ${id} (${email}) is now verified.`)
  }
}
