BEGIN;
-- AlterTable
ALTER TABLE "shell"."notification" ADD COLUMN     "retry_subject" TEXT,
ADD COLUMN     "retry_text" TEXT;

-- CreateTable
CREATE TABLE "shell"."rate_limit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "last_request" BIGINT NOT NULL,

    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_key_key" ON "shell"."rate_limit"("key");

GRANT DELETE ON "shell"."rate_limit" TO "app_runtime";
COMMIT;
