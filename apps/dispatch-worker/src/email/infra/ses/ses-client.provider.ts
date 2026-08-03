import { SESClient } from '@aws-sdk/client-ses'
import { type Provider } from '@nestjs/common'
import { awsENV } from '@ruguin/env'

export const sesClientProvider: Provider = {
  provide: SESClient,
  useFactory: (): SESClient =>
    new SESClient({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
    })
}
