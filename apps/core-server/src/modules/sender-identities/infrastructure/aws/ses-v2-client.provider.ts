import { SESv2Client } from '@aws-sdk/client-sesv2'
import { type Provider } from '@nestjs/common'
import { awsENV } from '@ruguin/env'

export const sesV2ClientProvider: Provider = {
  provide: SESv2Client,
  useFactory: (): SESv2Client =>
    new SESv2Client({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      /*
       * Static credentials are for LocalStack only — same pattern and rationale as
       * apps/dispatch-worker/src/email/infra/ses/ses-client.provider.ts: omitting `credentials`
       * falls through to the SDK's default credential provider chain in a real deployment.
       */
      ...(awsENV.AWS_ACCESS_KEY_ID !== undefined &&
        awsENV.AWS_SECRET_ACCESS_KEY !== undefined && {
          credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
        })
    })
}
