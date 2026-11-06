BEGIN;
-- CreateEnum
CREATE TYPE "credit"."OpeningBalanceStatus" AS ENUM ('PREPARED', 'COMMITTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "credit"."BankDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "credit"."BankLineCategory" AS ENUM ('BANK_CHARGE', 'BANK_INTEREST', 'INTERNAL_TRANSFER');

-- CreateEnum
CREATE TYPE "credit"."EntryStatus" AS ENUM ('PREPARED', 'VERIFIED', 'RETURNED');

-- AlterTable
ALTER TABLE "credit"."lodgement" ADD COLUMN     "applied_at" TIMESTAMPTZ(3),
ADD COLUMN     "applied_by_id" TEXT,
ADD COLUMN     "cash_event_id" UUID,
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_id" TEXT;

-- CreateTable
CREATE TABLE "credit"."bank_opening_balance" (
    "id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "as_of" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "evidence_id" UUID NOT NULL,
    "status" "credit"."OpeningBalanceStatus" NOT NULL DEFAULT 'PREPARED',
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "ledger_event_id" UUID,

    CONSTRAINT "bank_opening_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."statement_mapping" (
    "bank_account_id" UUID NOT NULL,
    "mapping" JSONB NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statement_mapping_pkey" PRIMARY KEY ("bank_account_id")
);

-- CreateTable
CREATE TABLE "credit"."bank_statement" (
    "id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "opening_balance" BIGINT NOT NULL,
    "closing_balance" BIGINT NOT NULL,
    "evidence_id" UUID NOT NULL,
    "checksum" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."bank_statement_line" (
    "id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "transaction_date" DATE NOT NULL,
    "value_date" DATE,
    "direction" "credit"."BankDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "running_balance" BIGINT,
    "uniqueness_key" TEXT NOT NULL,
    "lodgement_id" UUID,
    "voucher_id" UUID,
    "matched_by_id" TEXT,
    "matched_at" TIMESTAMPTZ(3),

    CONSTRAINT "bank_statement_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."direct_payment_tag" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "evidence_id" UUID,
    "note" TEXT,
    "tagged_by_id" TEXT NOT NULL,
    "tagged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lodgement_id" UUID,

    CONSTRAINT "direct_payment_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."bank_line_entry" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "category" "credit"."BankLineCategory" NOT NULL,
    "note" TEXT,
    "status" "credit"."EntryStatus" NOT NULL DEFAULT 'PREPARED',
    "recorded_by_id" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "return_reason" TEXT,
    "ledger_event_id" UUID,

    CONSTRAINT "bank_line_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bank_opening_balance_one_live" ON "credit"."bank_opening_balance"("bank_account_id") WHERE (status <> 'REJECTED');

-- CreateIndex
CREATE INDEX "bank_statement_bank_account_id_period_to_idx" ON "credit"."bank_statement"("bank_account_id", "period_to");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_line_uniqueness_key_key" ON "credit"."bank_statement_line"("uniqueness_key");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_line_lodgement_id_key" ON "credit"."bank_statement_line"("lodgement_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_line_voucher_id_key" ON "credit"."bank_statement_line"("voucher_id");

-- CreateIndex
CREATE INDEX "bank_statement_line_bank_account_id_transaction_date_idx" ON "credit"."bank_statement_line"("bank_account_id", "transaction_date");

-- CreateIndex
CREATE UNIQUE INDEX "direct_payment_tag_line_id_key" ON "credit"."direct_payment_tag"("line_id");

-- CreateIndex
CREATE UNIQUE INDEX "direct_payment_tag_reference_key" ON "credit"."direct_payment_tag"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "direct_payment_tag_lodgement_id_key" ON "credit"."direct_payment_tag"("lodgement_id");

-- CreateIndex
CREATE INDEX "direct_payment_tag_member_id_idx" ON "credit"."direct_payment_tag"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_line_entry_line_id_key" ON "credit"."bank_line_entry"("line_id");

-- AddForeignKey
ALTER TABLE "credit"."bank_opening_balance" ADD CONSTRAINT "bank_opening_balance_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "credit"."bank_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."statement_mapping" ADD CONSTRAINT "statement_mapping_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "credit"."bank_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."bank_statement" ADD CONSTRAINT "bank_statement_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "credit"."bank_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."bank_statement_line" ADD CONSTRAINT "bank_statement_line_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "credit"."bank_statement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."bank_statement_line" ADD CONSTRAINT "bank_statement_line_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "credit"."bank_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."bank_statement_line" ADD CONSTRAINT "bank_statement_line_lodgement_id_fkey" FOREIGN KEY ("lodgement_id") REFERENCES "credit"."lodgement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."bank_statement_line" ADD CONSTRAINT "bank_statement_line_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "credit"."voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."direct_payment_tag" ADD CONSTRAINT "direct_payment_tag_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "credit"."bank_statement_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."direct_payment_tag" ADD CONSTRAINT "direct_payment_tag_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "credit"."member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."direct_payment_tag" ADD CONSTRAINT "direct_payment_tag_lodgement_id_fkey" FOREIGN KEY ("lodgement_id") REFERENCES "credit"."lodgement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."bank_line_entry" ADD CONSTRAINT "bank_line_entry_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "credit"."bank_statement_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
