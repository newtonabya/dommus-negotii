BEGIN;
-- SMS message log (provider-agnostic SMS): the notification outbox gains the
-- provider's message id (delivery reports match on it), SMS units, the error,
-- the environment and an update time, plus a SKIPPED status for staging.
ALTER TYPE "shell"."NotificationStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';
ALTER TABLE "shell"."notification"
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "segments" INTEGER,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "environment" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ(3);
CREATE INDEX "notification_provider_message_id_idx" ON "shell"."notification"("provider_message_id");
COMMIT;
