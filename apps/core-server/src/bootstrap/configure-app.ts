import compress from '@fastify/compress'
import helmet from '@fastify/helmet'
import { VersioningType } from '@nestjs/common'
import { type NestFastifyApplication } from '@nestjs/platform-fastify'

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(helmet)
  await app.register(compress)

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
}
