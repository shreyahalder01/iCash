CREATE TYPE "ConversationRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "AIConversation" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "ConversationRole" NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AIConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TransactionEmbedding" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "embedding_vector" JSONB NOT NULL,
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransactionEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TransactionEmbedding_transaction_id_key" ON "TransactionEmbedding"("transaction_id");
CREATE INDEX "AIConversation_user_id_created_at_idx" ON "AIConversation"("user_id", "created_at");
CREATE INDEX "TransactionEmbedding_category_idx" ON "TransactionEmbedding"("category");

ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransactionEmbedding" ADD CONSTRAINT "TransactionEmbedding_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
