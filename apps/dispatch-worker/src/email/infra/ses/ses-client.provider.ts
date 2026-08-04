import { SESClient } from '@aws-sdk/client-ses'
import { type Provider } from '@nestjs/common'
import { awsENV } from '@ruguin/env'

export const sesClientProvider: Provider = {
  provide: SESClient,
  useFactory: (): SESClient =>
    new SESClient({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      /*
       * Static credentials are for LocalStack only. Setting `credentials` unconditionally would
       * suppress the AWS SDK's default credential provider chain (an ECS task role, an EKS
       * service-account role, an instance profile) everywhere, forcing a real deployment to carry
       * long-lived access keys that can't rotate automatically. Omitting `credentials` here falls
       * through to that default chain instead.
       */
      ...(awsENV.AWS_ACCESS_KEY_ID !== undefined &&
        awsENV.AWS_SECRET_ACCESS_KEY !== undefined && {
          credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
        })
    })
}
