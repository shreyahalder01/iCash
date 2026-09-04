CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "merchant" TEXT,
    "receipt_date" TIMESTAMP(3),
    "total" DECIMAL(12,2),
    "tax" DECIMAL(12,2),
    "image_path" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ReceiptItem" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(10,2),
    "amount" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "ReceiptItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SavingChallenge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "target_amount" DECIMAL(12,2),
    "duration_days" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SavingChallenge_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ChallengeProgress" (
    "id" TEXT NOT NULL,
    "challenge_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "current_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChallengeProgress_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Receipt_user_id_created_at_idx" ON "Receipt"("user_id", "created_at");
CREATE INDEX "ReceiptItem_receipt_id_idx" ON "ReceiptItem"("receipt_id");
CREATE UNIQUE INDEX "ChallengeProgress_challenge_id_user_id_key" ON "ChallengeProgress"("challenge_id", "user_id");
CREATE INDEX "ChallengeProgress_user_id_idx" ON "ChallengeProgress"("user_id");
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceiptItem" ADD CONSTRAINT "ReceiptItem_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChallengeProgress" ADD CONSTRAINT "ChallengeProgress_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "SavingChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChallengeProgress" ADD CONSTRAINT "ChallengeProgress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
