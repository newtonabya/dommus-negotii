BEGIN;
-- AlterTable
ALTER TABLE "shell"."user" ADD COLUMN     "preferred_channel" "shell"."NotificationChannel";

-- CreateTable
CREATE TABLE "credit"."announcement" (
    "id" UUID NOT NULL,
    "sent_by_id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "audience_label" TEXT NOT NULL,
    "via_sms" BOOLEAN NOT NULL,
    "via_email" BOOLEAN NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "recipient_count" INTEGER NOT NULL,
    "sms_count" INTEGER NOT NULL,
    "sms_units" INTEGER NOT NULL,
    "email_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcement_created_at_idx" ON "credit"."announcement"("created_at");

COMMIT;
