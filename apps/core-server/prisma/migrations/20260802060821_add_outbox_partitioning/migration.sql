-- Outbox becomes a partitioned table (RANGE by createdAt) with the new module/eventId/name/
-- nextAttemptAt columns. Postgres cannot ALTER an existing table into PARTITION BY, and there is no
-- data to preserve yet (no producer or consumer exists), so the table is dropped and recreated.
DROP TABLE "outbox_messages";

CREATE TABLE "outbox_messages" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_eventId_createdAt_key" ON "outbox_messages"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_status_createdAt_idx" ON "outbox_messages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_module_key_status_createdAt_idx" ON "outbox_messages"("module", "key", "status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_status_publishedAt_idx" ON "outbox_messages"("status", "publishedAt");

-- Initial partitions: the current month plus the two following, so inserts have somewhere to land
-- immediately. OutboxPartitionMaintenanceService (Task 6) takes over creating future partitions and
-- dropping old, empty ones.
CREATE TABLE "outbox_messages_2026_08" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "outbox_messages_2026_09" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "outbox_messages_2026_10" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
