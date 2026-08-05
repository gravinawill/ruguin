import { CreateEmailIdentityCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { Injectable } from '@nestjs/common'
import { type Either, failure, success } from '@ruguin/utils'

import { type SesIdentityProvider as SesIdentityProviderContract } from '../../domain/contracts/providers/ses-identity.provider'
import { CheckSesIdentityError } from '../../domain/errors/check-ses-identity.error'
import { CreateSesIdentityError } from '../../domain/errors/create-ses-identity.error'

@Injectable()
export class AwsSesIdentityProvider implements SesIdentityProviderContract {
  constructor(private readonly client: SESv2Client) {}

  public async createIdentity(input: { email: string }): Promise<Either<CreateSesIdentityError, void>> {
    try {
      await this.client.send(new CreateEmailIdentityCommand({ EmailIdentity: input.email }))
      return success(undefined)
    } catch (error: unknown) {
      return failure(new CreateSesIdentityError({ error }))
    }
  }

  public async getVerificationStatus(input: {
    email: string
  }): Promise<Either<CheckSesIdentityError, { verified: boolean }>> {
    try {
      const response = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: input.email }))
      return success({ verified: response.VerifiedForSendingStatus === true })
    } catch (error: unknown) {
      return failure(new CheckSesIdentityError({ error }))
    }
  }
}
