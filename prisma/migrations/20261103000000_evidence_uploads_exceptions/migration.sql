-- CreateEnum
CREATE TYPE "shell"."ExceptionStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'CLOSED');

-- CreateTable
CREATE TABLE "shell"."exception" (
    "id" UUID NOT NULL,
    "module_code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "shell"."ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "amount" BIGINT,
    "raised_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raised_by_id" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "closed_by_id" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "close_evidence_id" UUID,

    CONSTRAINT "exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence"."evidence_upload" (
    "id" UUID NOT NULL,
    "staging_key" TEXT NOT NULL,
    "declared_name" TEXT NOT NULL,
    "declared_type" TEXT NOT NULL,
    "declared_size" INTEGER NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "evidence_id" UUID,
    "rejected_reason" TEXT,

    CONSTRAINT "evidence_upload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exception_dedupe_key_key" ON "shell"."exception"("dedupe_key");

-- CreateIndex
CREATE INDEX "exception_status_raised_at_idx" ON "shell"."exception"("status", "raised_at");

-- CreateIndex
CREATE INDEX "exception_module_code_type_idx" ON "shell"."exception"("module_code", "type");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_upload_staging_key_key" ON "evidence"."evidence_upload"("staging_key");

-- CreateIndex
CREATE INDEX "evidence_upload_uploaded_by_id_created_at_idx" ON "evidence"."evidence_upload"("uploaded_by_id", "created_at");

-- Hand-written additions ─────────────────────────────────────────────────────

-- Uploads move from pending to finished (or rejected); the evidence schema's
-- default grants are insert-only, so allow updates on this one table.
GRANT UPDATE ON "evidence"."evidence_upload" TO "app_runtime";

-- Exceptions are never deleted; status changes are audited.
REVOKE DELETE ON "shell"."exception" FROM "app_runtime";
