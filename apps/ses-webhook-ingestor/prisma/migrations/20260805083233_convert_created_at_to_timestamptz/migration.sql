-- AlterTable
ALTER TABLE "ses_message_correlations"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3)
  USING "createdAt" AT TIME ZONE 'UTC';
