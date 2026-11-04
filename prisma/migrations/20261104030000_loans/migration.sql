-- Loan workflow: loans, guarantors, transitions, loan numbers, bank accounts, vouchers (PRD F7).
BEGIN;

-- CreateEnum
CREATE TYPE "credit"."LoanStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'VERIFIED', 'RECOMMENDED', 'APPROVED', 'DISBURSEMENT_PENDING', 'ACTIVE', 'CLOSED', 'DECLINED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "credit"."VoucherType" AS ENUM ('DISBURSEMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "credit"."VoucherStatus" AS ENUM ('PREPARED', 'VERIFIED', 'RETURNED');

-- CreateTable
CREATE TABLE "credit"."loan" (
    "id" UUID NOT NULL,
    "loan_account_no" TEXT,
    "legacy_account_no" TEXT,
    "member_id" UUID NOT NULL,
    "status" "credit"."LoanStatus" NOT NULL DEFAULT 'DRAFT',
    "assisted" BOOLEAN NOT NULL DEFAULT false,
    "purpose" TEXT NOT NULL,
    "amount_requested" BIGINT NOT NULL,
    "tenure_requested" INTEGER NOT NULL,
    "amount_approved" BIGINT,
    "tenure_approved" INTEGER,
    "rate_bps" INTEGER,
    "d0" DATE,
    "closed_on" DATE,
    "application_evidence_id" UUID,
    "binding_schedule" JSONB,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."guarantor" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "member_id" UUID,
    "moaum_id_number" TEXT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "form_evidence_id" UUID,

    CONSTRAINT "guarantor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."loan_transition" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "from_status" "credit"."LoanStatus",
    "to_status" "credit"."LoanStatus" NOT NULL,
    "by_user_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment" TEXT,

    CONSTRAINT "loan_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."loan_number_sequence" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "loan_number_sequence_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "credit"."bank_account" (
    "id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "branch" TEXT,
    "account_name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."voucher" (
    "id" UUID NOT NULL,
    "type" "credit"."VoucherType" NOT NULL,
    "loan_id" UUID,
    "status" "credit"."VoucherStatus" NOT NULL DEFAULT 'PREPARED',
    "amount" BIGINT NOT NULL,
    "value_date" DATE NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "transfer_ref" TEXT NOT NULL,
    "beneficiary_name" TEXT NOT NULL,
    "beneficiary_bank" TEXT NOT NULL,
    "beneficiary_account_no" TEXT NOT NULL,
    "evidence_id" UUID NOT NULL,
    "prepared_by_id" TEXT NOT NULL,
    "prepared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "return_reason" TEXT,
    "ledger_event_id" UUID,

    CONSTRAINT "voucher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loan_loan_account_no_key" ON "credit"."loan"("loan_account_no");

-- CreateIndex
CREATE UNIQUE INDEX "loan_legacy_account_no_key" ON "credit"."loan"("legacy_account_no");

-- CreateIndex
CREATE INDEX "loan_member_id_status_idx" ON "credit"."loan"("member_id", "status");

-- CreateIndex
CREATE INDEX "loan_status_updated_at_idx" ON "credit"."loan"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "guarantor_loan_id_key" ON "credit"."guarantor"("loan_id");

-- CreateIndex
CREATE INDEX "guarantor_moaum_id_number_idx" ON "credit"."guarantor"("moaum_id_number");

-- CreateIndex
CREATE INDEX "guarantor_phone_idx" ON "credit"."guarantor"("phone");

-- CreateIndex
CREATE INDEX "loan_transition_loan_id_at_idx" ON "credit"."loan_transition"("loan_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_account_number_key" ON "credit"."bank_account"("account_number");

-- CreateIndex
CREATE INDEX "voucher_loan_id_idx" ON "credit"."voucher"("loan_id");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_one_prepared" ON "credit"."voucher"("loan_id") WHERE (status = 'PREPARED');

-- AddForeignKey
ALTER TABLE "credit"."loan" ADD CONSTRAINT "loan_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "credit"."member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."guarantor" ADD CONSTRAINT "guarantor_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "credit"."loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."guarantor" ADD CONSTRAINT "guarantor_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "credit"."member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."loan_transition" ADD CONSTRAINT "loan_transition_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "credit"."loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."voucher" ADD CONSTRAINT "voucher_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "credit"."loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."voucher" ADD CONSTRAINT "voucher_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "credit"."bank_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Status history is append-only for the app.
CREATE TRIGGER "loan_transition_append_only" BEFORE UPDATE OR DELETE ON "credit"."loan_transition"
  FOR EACH ROW EXECUTE FUNCTION "shell"."reject_change"();

COMMIT;
