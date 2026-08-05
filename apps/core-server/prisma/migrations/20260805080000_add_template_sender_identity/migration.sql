-- AlterTable
ALTER TABLE "templates" ADD COLUMN "senderIdentityId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "templates_senderIdentityId_idx" ON "templates"("senderIdentityId");
