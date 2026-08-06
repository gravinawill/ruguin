import { execSync } from 'node:child_process'

/*
 * Shared by both e2e globalSetups (the existing `e2e` project and the new `pipeline-e2e` project,
 * apps/core-server/vitest.config.ts) — each needs the exact same seeded organization/project/
 * sender identity/template/API key, and duplicating this parsing in two files would drift the
 * moment one of them changes the seed script's output format.
 */
export function runSeedAndCaptureIds(): void {
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
  /*
   * awsENV's own fields all default or are optional except these — the SES v2 client (sender
   * identity registration) needs them to point at LocalStack instead of real AWS during e2e.
   * 'test'/'test' is the same placeholder value packages/env's own aws.environment.unit.ts already
   * uses for the identical purpose.
   */
  process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566'
  process.env.AWS_ACCESS_KEY_ID ??= 'test'
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test'

  // eslint-disable-next-line sonarjs/no-os-command-from-path -- static command, no interpolated input; `pnpm exec` is the intended way to resolve workspace-local binaries via PATH.
  const seedOutput = execSync('pnpm exec tsx prisma/seed.ts', {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    encoding: 'utf8'
  })

  const organizationId = /organizationId:\s+(\S+)/.exec(seedOutput)?.[1]
  const projectId = /projectId:\s+(\S+)/.exec(seedOutput)?.[1]
  const senderIdentityId = /senderIdentityId:\s+(\S+)/.exec(seedOutput)?.[1]
  const senderIdentityEmail = /senderIdentityEmail:\s+(\S+)/.exec(seedOutput)?.[1]
  const templateId = /templateId:\s+(\S+)/.exec(seedOutput)?.[1]
  const apiKey = /API key:\s+(\S+)/.exec(seedOutput)?.[1]

  /*
   * Report which fields failed to parse, never the raw output — it carries the seeded API key in
   * cleartext, and this message can land in a CI log with far wider, longer-lived reach than the
   * terminal it was meant for.
   */
  if (
    organizationId === undefined ||
    projectId === undefined ||
    senderIdentityId === undefined ||
    senderIdentityEmail === undefined ||
    templateId === undefined ||
    apiKey === undefined
  ) {
    const missing = Object.entries({
      organizationId,
      projectId,
      senderIdentityId,
      senderIdentityEmail,
      templateId,
      apiKey
    })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name)
    throw new Error(`Failed to parse seed output — missing: ${missing.join(', ')}.`)
  }

  process.env.TEST_SEEDED_ORGANIZATION_ID = organizationId
  process.env.TEST_SEEDED_PROJECT_ID = projectId
  process.env.TEST_SEEDED_SENDER_IDENTITY_ID = senderIdentityId
  process.env.TEST_SEEDED_SENDER_IDENTITY_EMAIL = senderIdentityEmail
  process.env.TEST_SEEDED_TEMPLATE_ID = templateId
  process.env.TEST_SEEDED_API_KEY = apiKey
}
