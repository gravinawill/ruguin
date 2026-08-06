-- DropIndex
--
-- `emails_projectId_idx` was originally created by `CREATE INDEX` (transactional, blocking) in
-- 20260805060000_add_emails. This migration and the one that follows it recreate the same index
-- via CONCURRENTLY instead, so a future first-time deploy against a populated `emails` table
-- doesn't take an ACCESS EXCLUSIVE lock while building it. Each CONCURRENTLY statement must be
-- its own migration file — Postgres refuses CREATE/DROP INDEX CONCURRENTLY inside a transaction
-- block, and Prisma wraps a migration.sql containing more than one statement in one.
DROP INDEX CONCURRENTLY IF EXISTS "emails_projectId_idx";
