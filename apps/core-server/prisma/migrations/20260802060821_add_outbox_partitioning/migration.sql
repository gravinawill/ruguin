-- Outbox becomes a partitioned table (RANGE by createdAt) with the new module/eventId/name/
-- nextAttemptAt columns. Postgres cannot ALTER an existing table into PARTITION BY, so the table
-- has to be recreated — but unlike a plain DROP TABLE, this migration refuses to destroy data:
-- it aborts with an explicit error if the table is not empty, instead of assuming it.
--
-- This table has never had a real producer or consumer up to this point in the codebase's
-- history, and it should be empty on every environment this migration has ever run against. But
-- "should be empty" is an assumption, not a guarantee a migration is allowed to bet real data on.
-- If it is ever wrong — a manual insert, a hotfix that shipped early, a restored backup — this
-- guard stops the migration instead of silently dropping those rows. There is no safe backfill to
-- write for that case: module/eventId/name are new columns with no equivalent in the old schema,
-- so any value this migration invented for them would be a guess, not a migration. Recovery is a
-- human decision at that point (restore from a pre-deploy backup, or hand-write a real backfill
-- once the actual old data is known), not something this file can do for them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "outbox_messages" LIMIT 1) THEN
    RAISE EXCEPTION 'outbox_messages is not empty — refusing to repartition it automatically. Back up the table, then either truncate it and re-run this migration, or write a manual backfill for the new module/eventId/name columns before repartitioning.';
  END IF;
END $$;

ALTER TABLE "outbox_messages" RENAME TO "outbox_messages_pre_partition";

-- RENAME TO does not rename the table's own constraint/index names, and Postgres requires those
-- to be unique per schema, not just per table — without freeing them here, the new table below
-- would collide with the old one's still-attached "outbox_messages_pkey" and
-- "outbox_messages_status_createdAt_idx" the moment it tries to claim the same names.
ALTER TABLE "outbox_messages_pre_partition" RENAME CONSTRAINT "outbox_messages_pkey" TO "outbox_messages_pre_partition_pkey";
ALTER INDEX "outbox_messages_status_createdAt_idx" RENAME TO "outbox_messages_pre_partition_status_createdAt_idx";

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

-- The guard above already proves the table is empty at this point, so a regular CREATE INDEX
-- (which briefly locks writes while it builds) has no writes to lock and no rows to scan —
-- CONCURRENTLY exists to avoid blocking a table under real write traffic, which this table
-- provably has none of yet. If a future migration ever removes the guard above to support a real
-- backfill, revisit this: CONCURRENTLY on a partitioned parent requires building each partition's
-- index separately (CONCURRENTLY cannot be combined with PARTITION BY directly) and cannot run
-- inside the transaction Prisma wraps this file in.

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_eventId_createdAt_key" ON "outbox_messages"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_status_createdAt_idx" ON "outbox_messages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_module_key_status_createdAt_id_idx" ON "outbox_messages"("module", "key", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "outbox_messages_status_publishedAt_idx" ON "outbox_messages"("status", "publishedAt");

-- CreateIndex: matches the relay's ROW_NUMBER() OVER (PARTITION BY module, key ORDER BY
-- createdAt, id) exactly, with status leading instead of module/key — the relay scans every
-- module/key each tick, not one, so an index led by status is what actually serves that scan.
CREATE INDEX "outbox_messages_status_module_key_createdAt_id_idx" ON "outbox_messages"("status", "module", "key", "createdAt", "id");

-- Initial partitions: the current month plus the two following, so inserts have somewhere to land
-- immediately. OutboxPartitionMaintenanceService (Task 6) takes over creating future partitions and
-- dropping old, empty ones.
CREATE TABLE "outbox_messages_2026_08" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "outbox_messages_2026_09" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "outbox_messages_2026_10" PARTITION OF "outbox_messages"
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- The guard above proved this table empty before the rename, so it is safe to drop now.
DROP TABLE "outbox_messages_pre_partition";
