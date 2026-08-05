import { execSync } from 'node:child_process'

process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'
process.env.ENVIRONMENT ??= 'test'

// eslint-disable-next-line sonarjs/no-os-command-from-path -- static command, no interpolated input; `pnpm exec` is the intended way to resolve workspace-local binaries via PATH.
const seedOutput = execSync('pnpm exec tsx prisma/seed.ts', {
  cwd: new URL('.', import.meta.url).pathname,
  env: process.env,
  encoding: 'utf8'
})

const organizationId = /organizationId:\s+(\S+)/.exec(seedOutput)?.[1]
const projectId = /projectId:\s+(\S+)/.exec(seedOutput)?.[1]
const templateId = /templateId:\s+(\S+)/.exec(seedOutput)?.[1]
const apiKey = /API key:\s+(\S+)/.exec(seedOutput)?.[1]

if (organizationId === undefined || projectId === undefined || templateId === undefined || apiKey === undefined) {
  throw new Error(`Failed to parse seed output:\n${seedOutput}`)
}

process.env.TEST_SEEDED_ORGANIZATION_ID = organizationId
process.env.TEST_SEEDED_PROJECT_ID = projectId
process.env.TEST_SEEDED_TEMPLATE_ID = templateId
process.env.TEST_SEEDED_API_KEY = apiKey
