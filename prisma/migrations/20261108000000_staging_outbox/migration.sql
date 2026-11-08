BEGIN;
-- CreateTable
CREATE TABLE "shell"."staging_outbox" (
    "id" UUID NOT NULL,
    "channel" "shell"."NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "template" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staging_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staging_outbox_created_at_idx" ON "shell"."staging_outbox"("created_at");


-- Staging-only scratch table: old rows are deleted (default grants are insert/update only).
GRANT DELETE ON "shell"."staging_outbox" TO "app_runtime";
COMMIT;
