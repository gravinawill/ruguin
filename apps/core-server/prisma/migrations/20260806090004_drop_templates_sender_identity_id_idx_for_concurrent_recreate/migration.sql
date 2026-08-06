-- DropIndex
--
-- `templates_senderIdentityId_idx` was originally created by CREATE INDEX (transactional,
-- blocking) in 20260805080000_add_template_sender_identity. Recreated CONCURRENTLY across this
-- migration and the one that follows it — see 20260806090000's comment for why each statement
-- needs its own file.
DROP INDEX CONCURRENTLY IF EXISTS "templates_senderIdentityId_idx";
