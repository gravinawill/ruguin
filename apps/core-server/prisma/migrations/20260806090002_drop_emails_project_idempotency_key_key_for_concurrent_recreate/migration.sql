-- DropIndex
--
-- `emails_project_idempotency_key_key` (partial unique index over (projectId, idempotencyKey)
-- WHERE idempotencyKey IS NOT NULL) was originally created by CREATE UNIQUE INDEX (transactional,
-- blocking) in 20260805060000_add_emails. Recreated CONCURRENTLY across this migration and the
-- one that follows it — see 20260806090000's comment for why each statement needs its own file.
DROP INDEX CONCURRENTLY IF EXISTS "emails_project_idempotency_key_key";
