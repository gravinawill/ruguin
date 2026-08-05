import { execSync } from 'node:child_process'

process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=core_server'
process.env.ENVIRONMENT ??= 'test'
/*
 * app.module.ts now wires MessageBrokerModule (publishing side of the outbox→dispatch-worker
 * flow) — matches apps/dispatch-worker's own docker-compose Kafka listener.
 */
process.env.KAFKA_BOOTSTRAP_BROKERS ??= 'localhost:9092'
/*
 * CACHE_PREFIX has no default in cacheENV's schema (packages/env) — CACHE_DRIVER is left unset
 * so it falls back to 'memory', keeping the e2e suite self-sufficient without a live Valkey.
 */
process.env.CACHE_PREFIX ??= 'ruguin-core-server-e2e'
/*
 * docsENV requires both with no default (packages/env/src/packages/docs.environment.ts). Test-only
 * Basic Auth credentials for the /docs routes this suite never authenticates against — not a
 * secret, just what coreServerENV needs present to resolve at all.
 */
process.env.DOCS_USERNAME ??= 'e2e-test'
process.env.DOCS_PASSWORD ??= 'e2e-test'

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

/*
 * Report which fields failed to parse, never the raw output — it carries the seeded API key in
 * cleartext, and this message can land in a CI log with far wider, longer-lived reach than the
 * terminal it was meant for.
 */
if (organizationId === undefined || projectId === undefined || templateId === undefined || apiKey === undefined) {
  const missing = Object.entries({ organizationId, projectId, templateId, apiKey })
    .filter(([, value]) => value === undefined)
    .map(([name]) => name)
  throw new Error(`Failed to parse seed output — missing: ${missing.join(', ')}.`)
}

process.env.TEST_SEEDED_ORGANIZATION_ID = organizationId
process.env.TEST_SEEDED_PROJECT_ID = projectId
process.env.TEST_SEEDED_TEMPLATE_ID = templateId
process.env.TEST_SEEDED_API_KEY = apiKey
