import { defineConfig } from 'prisma/config'

import { withSchema } from './src/shared/infrastructure/database/database-schema.ts'

const databaseUrl = process.env.DATABASE_URL
const datasource = databaseUrl === undefined || databaseUrl === '' ? {} : { url: withSchema(databaseUrl) }

export default defineConfig({
  datasource,
  migrations: {
    path: './prisma/migrations'
  },
  schema: './prisma/schema'
})
