import { createHash, randomBytes } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../src/shared/infrastructure/database/prisma/generated/client'

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL must be set to run the seed.')
  }

  const schema = new URL(connectionString).searchParams.get('schema')
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, schema === null || schema === '' ? {} : { schema })
  })

  const organization = await prisma.organization.create({ data: { name: 'Dev Organization' } })
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: 'Dev Project' } })
  const template = await prisma.template.create({
    data: { projectId: project.id, name: 'Welcome', subject: 'Hi {{name}}', html: '<p>Hi {{name}}</p>' }
  })

  /*
   * 32 bytes of entropy, hex-encoded — see design spec decision 9. Printed once; never
   * recoverable afterward, matching the guarantee that only its hash is ever persisted.
   */
  const rawApiKey = randomBytes(32).toString('hex')
  const hashedKey = createHash('sha256').update(rawApiKey).digest('hex')
  await prisma.apiKey.create({ data: { projectId: project.id, hashedKey } })

  console.log('Seeded development data:')
  console.log(`  organizationId: ${organization.id}`)
  console.log(`  projectId:      ${project.id}`)
  console.log(`  templateId:     ${template.id}`)
  console.log(`  API key:        ${rawApiKey}`)
  console.log('This key is shown once. It is not recoverable — re-run the seed to mint a new one.')

  await prisma.$disconnect()
}

await main()
