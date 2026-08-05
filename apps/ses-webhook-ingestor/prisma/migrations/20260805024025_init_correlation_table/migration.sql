-- CreateTable
CREATE TABLE "ses_message_correlations" (
    "sesMessageId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ses_message_correlations_pkey" PRIMARY KEY ("sesMessageId")
);
