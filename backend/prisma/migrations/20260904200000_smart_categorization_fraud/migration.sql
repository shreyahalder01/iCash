ALTER TABLE "Transaction"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "category_confidence" DECIMAL(5,4),
  ADD COLUMN "category_user_corrected" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "FraudAnalysis" (
  "id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "risk_score" DECIMAL(5,4) NOT NULL,
  "risk_level" "Severity" NOT NULL DEFAULT 'LOW',
  "indicators" JSONB,
  "model_version" TEXT NOT NULL DEFAULT 'rules-v1',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FraudAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FraudAnalysis_transaction_id_key" ON "FraudAnalysis"("transaction_id");
CREATE INDEX "FraudAnalysis_risk_level_idx" ON "FraudAnalysis"("risk_level");
CREATE INDEX "FraudAnalysis_created_at_idx" ON "FraudAnalysis"("created_at");
ALTER TABLE "FraudAnalysis" ADD CONSTRAINT "FraudAnalysis_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
