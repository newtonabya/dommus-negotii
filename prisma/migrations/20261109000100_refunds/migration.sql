BEGIN;
-- CreateEnum
CREATE TYPE "credit"."RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'PAID');

-- CreateEnum
CREATE TYPE "credit"."ReclassificationStatus" AS ENUM ('PREPARED', 'VERIFIED', 'RETURNED');

-- AlterTable
ALTER TABLE "credit"."voucher" ADD COLUMN     "refund_id" UUID;

-- CreateTable
CREATE TABLE "credit"."refund" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "credit"."RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "channel" TEXT NOT NULL,
    "request_evidence_id" UUID,
    "note" TEXT,
    "beneficiary_name" TEXT NOT NULL,
    "beneficiary_bank" TEXT NOT NULL,
    "beneficiary_account_no" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,
    "paid_at" TIMESTAMPTZ(3),

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."reclassification" (
    "id" UUID NOT NULL,
    "row_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence_id" UUID NOT NULL,
    "status" "credit"."ReclassificationStatus" NOT NULL DEFAULT 'PREPARED',
    "prepared_by_id" TEXT NOT NULL,
    "prepared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "return_comment" TEXT,

    CONSTRAINT "reclassification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_status_requested_at_idx" ON "credit"."refund"("status", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "refund_one_open" ON "credit"."refund"("member_id") WHERE (status IN ('REQUESTED', 'APPROVED'));

-- CreateIndex
CREATE INDEX "reclassification_row_id_idx" ON "credit"."reclassification"("row_id");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_one_prepared_refund" ON "credit"."voucher"("refund_id") WHERE (status = 'PREPARED');

-- AddForeignKey
ALTER TABLE "credit"."voucher" ADD CONSTRAINT "voucher_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "credit"."refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."refund" ADD CONSTRAINT "refund_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "credit"."member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."reclassification" ADD CONSTRAINT "reclassification_row_id_fkey" FOREIGN KEY ("row_id") REFERENCES "credit"."remittance_row"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
