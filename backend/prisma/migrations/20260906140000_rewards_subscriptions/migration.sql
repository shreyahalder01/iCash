CREATE TABLE "RewardBadge" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "awarded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RewardBadge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RewardBadge_user_id_code_key" ON "RewardBadge"("user_id", "code");
CREATE INDEX "RewardBadge_user_id_awarded_at_idx" ON "RewardBadge"("user_id", "awarded_at");
ALTER TABLE "RewardBadge" ADD CONSTRAINT "RewardBadge_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "merchant" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "interval_days" INTEGER NOT NULL,
  "next_due_at" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "reminder_sent" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Subscription_user_id_active_idx" ON "Subscription"("user_id", "active");
CREATE INDEX "Subscription_merchant_idx" ON "Subscription"("merchant");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
