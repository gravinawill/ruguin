-- CreateIndex
--
-- Same partial-unique semantics as the original (docs/superpowers/specs/2026-08-04-core-server-
-- auth-and-send-design.md, decision 2): idempotencyKey IS NOT NULL scopes the constraint so two
-- emails with no Idempotency-Key never collide. Between this migration and the one before it, the
-- database briefly has no idempotency guarantee at the constraint level — acceptable here because
-- this whole sequence runs as one uninterrupted `migrate deploy` and the project has no production
-- traffic yet; a genuinely live deploy of this pattern would need a maintenance window or an
-- application-level idempotency guard for that gap.
CREATE UNIQUE INDEX CONCURRENTLY "emails_project_idempotency_key_key"
  ON "emails" ("projectId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
