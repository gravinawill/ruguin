import { defineConfig } from 'prisma/config'

const databaseUrl = process.env.DATABASE_URL
const datasource = databaseUrl === undefined || databaseUrl === '' ? {} : { url: databaseUrl }

export default defineConfig({
  datasource,
  migrations: {
    path: './prisma/migrations'
  },
  schema: './prisma/schema'
})
