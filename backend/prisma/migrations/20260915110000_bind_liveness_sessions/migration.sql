ALTER TABLE "BiometricChallenge" ADD COLUMN "liveness_session_id" TEXT;
CREATE INDEX "BiometricChallenge_liveness_session_id_idx" ON "BiometricChallenge"("liveness_session_id");
