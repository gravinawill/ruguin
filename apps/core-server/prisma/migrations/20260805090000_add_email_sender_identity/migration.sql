-- AlterTable
ALTER TABLE "emails" ADD COLUMN "senderIdentityId" TEXT NOT NULL,
ALTER COLUMN "templateId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "emails_senderIdentityId_idx" ON "emails"("senderIdentityId");
