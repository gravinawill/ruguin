import { randomBytes } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'

import { hashApiKey } from '../src/modules/api-keys/domain/hash-api-key'
import { PrismaClient } from '../src/shared/infrastructure/database/prisma/generated/client'

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL must be set to run the seed.')
  }

  /*
   * This app owns exactly one Postgres schema, core_server (see apps/core-server/CLAUDE.md) — a
   * DATABASE_URL missing ?schema= or pointing at a different one would silently seed into the
   * wrong place (Postgres defaults to `public`) rather than fail loudly.
   */
  const schema = new URL(connectionString).searchParams.get('schema')
  if (schema !== 'core_server') {
    throw new Error(`DATABASE_URL must include ?schema=core_server to run the seed (got: ${schema ?? 'none'}).`)
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) })

  const organization = await prisma.organization.create({ data: { name: 'Dev Organization' } })
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: 'Dev Project' } })

  /*
   * Written directly, verifiedAt already set — bypasses the real SES CreateEmailIdentity call
   * (design spec decision 9) so dev/test never depends on AWS/LocalStack actually confirming a
   * mailbox that doesn't exist.
   */
  const senderIdentity = await prisma.senderIdentity.create({
    data: { projectId: project.id, name: 'Dev Sender', email: 'dev-sender@ruguin.dev', verifiedAt: new Date() }
  })

  const template = await prisma.template.create({
    data: {
      projectId: project.id,
      senderIdentityId: senderIdentity.id,
      name: 'Welcome',
      subject: 'Hi {{name}}',
      html: '<p>Hi {{name}}</p>'
    }
  })

  /*
   * 32 bytes of entropy, hex-encoded — see design spec decision 9. Printed once; never
   * recoverable afterward, matching the guarantee that only its hash is ever persisted.
   */
  const rawApiKey = randomBytes(32).toString('hex')
  const hashedKey = hashApiKey({ rawKey: rawApiKey })
  await prisma.apiKey.create({ data: { projectId: project.id, hashedKey } })

  console.log('Seeded development data:')
  console.log(`  organizationId:   ${organization.id}`)
  console.log(`  projectId:        ${project.id}`)
  console.log(`  senderIdentityId: ${senderIdentity.id}`)
  console.log(`  templateId:       ${template.id}`)
  console.log(`  API key:          ${rawApiKey}`)
  console.log('This key is shown once. It is not recoverable — re-run the seed to mint a new one.')

  await prisma.$disconnect()
}

await main()
