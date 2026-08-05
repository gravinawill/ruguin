-- CreateTable
CREATE TABLE "sender_identities" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sender_identities_email_key" ON "sender_identities"("email");

-- CreateIndex
CREATE INDEX "sender_identities_projectId_idx" ON "sender_identities"("projectId");
