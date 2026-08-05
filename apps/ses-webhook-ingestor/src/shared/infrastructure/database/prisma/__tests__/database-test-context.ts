import { PrismaService } from '../prisma.service.ts'

/*
 * Reads a dedicated variable, never the app's own DATABASE_URL — see the identical comment in
 * apps/core-server/src/shared/infrastructure/outbox/__tests__/outbox-test-context.ts. Schema name
 * matches app.module.ts's DATABASE_SCHEMA constant.
 */
export const TEST_DATABASE_URL: string =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ruguin:ruguin@localhost:5432/ruguin?schema=ses_webhook_ingestor'

export const createTestPrismaService = (): PrismaService => new PrismaService(TEST_DATABASE_URL)
