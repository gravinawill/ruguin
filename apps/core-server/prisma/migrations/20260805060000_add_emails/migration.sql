-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED');

-- CreateTable
CREATE TABLE "emails" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "templateId" TEXT,
    "idempotencyKey" TEXT,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emails_projectId_idx" ON "emails"("projectId");

-- A plain @@unique([projectId, idempotencyKey]) would reject every second email that omits
-- Idempotency-Key, since NULL <> NULL only holds for non-partial unique indexes in intent, not
-- in Postgres's actual NULL-handling — a standard unique index already treats multiple NULLs as
-- distinct. This index exists to be explicit about scope (idempotencyKey IS NOT NULL) and to
-- document, at the SQL level, that the constraint is intentionally partial, matching the design
-- spec (docs/superpowers/specs/2026-08-04-core-server-auth-and-send-design.md, decision 2).
CREATE UNIQUE INDEX "emails_project_idempotency_key_key"
  ON "emails" ("projectId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
