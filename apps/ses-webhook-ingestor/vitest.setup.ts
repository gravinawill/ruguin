import 'reflect-metadata'

/*
 * Shared by the "integration" and "e2e" vitest projects (vitest.config.ts) — both boot the real
 * AppModule via Test.createTestingModule, which forces sesWebhookIngestorENV to resolve at
 * import time (src/app.module.ts's deliberate `void sesWebhookIngestorENV.SES_WEBHOOK_INGESTOR_SHARED_SECRET`).
 * Without these defaults, both suites fail with "Invalid environment variables" whenever the
 * invoking shell doesn't already export them — e.g. `.husky/pre-push`'s plain `pnpm test`.
 */
process.env.DATABASE_URL ??= 'postgresql://ruguin:ruguin@localhost:5432/ruguin'
process.env.ENVIRONMENT ??= 'test'
process.env.KAFKA_BOOTSTRAP_BROKERS ??= 'localhost:9092'
process.env.CACHE_PREFIX ??= 'ruguin-ses-webhook-ingestor-e2e'
/*
 * No default in sesWebhookIngestorENV's schema (packages/env) — min(32), required. Test-only
 * value, not a real secret: only this app's own SesWebhookAuthGuard ever compares against it, and
 * these suites never call a real EventBridge endpoint with it.
 */
process.env.SES_WEBHOOK_INGESTOR_SHARED_SECRET ??= 'e2e-test-shared-secret-do-not-use-in-production'
