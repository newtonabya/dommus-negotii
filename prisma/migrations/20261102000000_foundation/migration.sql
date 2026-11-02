-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "evidence";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ledger";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shell";

-- CreateEnum
CREATE TYPE "shell"."ModuleStatus" AS ENUM ('LIVE', 'DEGRADED', 'OFFLINE');

-- CreateEnum
CREATE TYPE "shell"."Role" AS ENUM ('MEMBER', 'TREASURER', 'FINANCE_MANAGER', 'CASHIER', 'LOAN_OFFICER', 'MANAGEMENT', 'AUDITOR', 'ADMIN', 'GMD', 'SECRETARY');

-- CreateEnum
CREATE TYPE "shell"."ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "shell"."NotificationChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "shell"."NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "ledger"."LedgerEventType" AS ENUM ('OPENING_BALANCE', 'CASH_IN', 'CASH_OUT', 'PRINCIPAL_RECOVERY', 'INTEREST_INCOME', 'DEPOSIT_CREDITED', 'DEPOSIT_REFUNDED', 'SCHEDULE_ACCEPTED', 'SCHEDULE_POSTED', 'LODGEMENT_BANK_VERIFIED', 'LODGEMENT_APPLIED', 'LODGEMENT_UNAPPLIED', 'BANK_DEPOSIT');

-- CreateEnum
CREATE TYPE "ledger"."LedgerSource" AS ENUM ('REMITTANCE_SCHEDULE', 'BANK_SLIP', 'BANK_STATEMENT', 'DISBURSEMENT_VOUCHER', 'REFUND_VOUCHER', 'LEGACY_IMPORT', 'RECEIPT_ENTRY', 'EXCEL_BATCH', 'LIVE_PAYMENT');

-- CreateEnum
CREATE TYPE "evidence"."EvidenceKind" AS ENUM ('PRIMARY', 'SUPPORTING');

-- CreateTable
CREATE TABLE "shell"."module" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "shell"."ModuleStatus" NOT NULL DEFAULT 'LIVE',
    "event_types" TEXT[],
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "module_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "shell"."user_module_role" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,
    "role" "shell"."Role" NOT NULL,
    "assigned_by_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_module_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT,
    "ip_address" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "evidence_ref" UUID,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."setting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "change_request_id" UUID,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."setting_change_request" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "proposed_value" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "proposed_by_id" TEXT NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "shell"."ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,

    CONSTRAINT "setting_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."notification" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "channel" "shell"."NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "shell"."NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "provider_response" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger"."ledger_event" (
    "event_id" UUID NOT NULL,
    "occurred_at" DATE NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "module_code" TEXT NOT NULL,
    "event_type" "ledger"."LedgerEventType" NOT NULL,
    "source" "ledger"."LedgerSource" NOT NULL,
    "evidence_refs" UUID[],
    "portal_user_id" TEXT NOT NULL,
    "module_entity_type" TEXT NOT NULL,
    "module_entity_id" TEXT NOT NULL,
    "bank_account_id" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "cash_amount" BIGINT NOT NULL DEFAULT 0,
    "revenue_amount" BIGINT NOT NULL DEFAULT 0,
    "deposit_delta" BIGINT NOT NULL DEFAULT 0,
    "principal_amount" BIGINT NOT NULL DEFAULT 0,
    "interest_amount" BIGINT NOT NULL DEFAULT 0,
    "retention_amount" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "uniqueness_key" TEXT NOT NULL,
    "reverses_event_id" UUID,
    "schema_version" INTEGER NOT NULL DEFAULT 2,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ledger_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "evidence"."evidence_file" (
    "id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence"."evidence_link" (
    "id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "kind" "evidence"."EvidenceKind" NOT NULL,
    "submission_key" TEXT NOT NULL,
    "duplicate_reason" TEXT,
    "linked_by_id" TEXT NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_module_role_user_id_module_code_role_key" ON "shell"."user_module_role"("user_id", "module_code", "role");

-- CreateIndex
CREATE INDEX "audit_log_user_id_occurred_at_idx" ON "shell"."audit_log"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "shell"."audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_action_occurred_at_idx" ON "shell"."audit_log"("action", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "setting_change_request_id_key" ON "shell"."setting"("change_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "setting_key_effective_from_key" ON "shell"."setting"("key", "effective_from");

-- CreateIndex
CREATE INDEX "setting_change_request_status_idx" ON "shell"."setting_change_request"("status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_idempotency_key_key" ON "shell"."notification"("idempotency_key");

-- CreateIndex
CREATE INDEX "notification_status_created_at_idx" ON "shell"."notification"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_event_uniqueness_key_key" ON "ledger"."ledger_event"("uniqueness_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_event_reverses_event_id_key" ON "ledger"."ledger_event"("reverses_event_id");

-- CreateIndex
CREATE INDEX "ledger_event_module_code_event_type_occurred_at_idx" ON "ledger"."ledger_event"("module_code", "event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "ledger_event_module_entity_type_module_entity_id_idx" ON "ledger"."ledger_event"("module_entity_type", "module_entity_id");

-- CreateIndex
CREATE INDEX "ledger_event_bank_account_id_occurred_at_idx" ON "ledger"."ledger_event"("bank_account_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_file_sha256_key" ON "evidence"."evidence_file"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_file_storage_key_key" ON "evidence"."evidence_file"("storage_key");

-- CreateIndex
CREATE INDEX "evidence_link_evidence_id_kind_idx" ON "evidence"."evidence_link"("evidence_id", "kind");

-- CreateIndex
CREATE INDEX "evidence_link_entity_type_entity_id_idx" ON "evidence"."evidence_link"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_link_evidence_id_entity_type_entity_id_key" ON "evidence"."evidence_link"("evidence_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "shell"."user_module_role" ADD CONSTRAINT "user_module_role_module_code_fkey" FOREIGN KEY ("module_code") REFERENCES "shell"."module"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shell"."setting" ADD CONSTRAINT "setting_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "shell"."setting_change_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger"."ledger_event" ADD CONSTRAINT "ledger_event_reverses_event_id_fkey" FOREIGN KEY ("reverses_event_id") REFERENCES "ledger"."ledger_event"("event_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence"."evidence_link" ADD CONSTRAINT "evidence_link_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"."evidence_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
