-- Remittance schedules, Source Advices and lodgements (PRD F9).
BEGIN;

-- CreateEnum
CREATE TYPE "credit"."AdviceStatus" AS ENUM ('AVAILABLE', 'USED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "credit"."ScheduleType" AS ENUM ('REGULAR', 'SUPPLEMENTARY');

-- CreateEnum
CREATE TYPE "credit"."LodgementStatus" AS ENUM ('UNVERIFIED', 'BANK_VERIFIED', 'APPLIED');

-- AlterEnum
ALTER TYPE "credit"."ImportKind" ADD VALUE 'REMITTANCE_SCHEDULE';

-- AlterTable
ALTER TABLE "credit"."import_batch" ADD COLUMN     "header" JSONB;

-- CreateTable
CREATE TABLE "credit"."source_advice" (
    "id" UUID NOT NULL,
    "remittance_source_id" UUID NOT NULL,
    "month_covered" TEXT NOT NULL,
    "advice_reference" TEXT NOT NULL,
    "control_total" BIGINT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "evidence_id" UUID NOT NULL,
    "status" "credit"."AdviceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_advice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."source_advice_row" (
    "id" UUID NOT NULL,
    "advice_id" UUID NOT NULL,
    "moaum_id_number" TEXT NOT NULL,
    "member_name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "source_advice_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."remittance_schedule" (
    "id" UUID NOT NULL,
    "remittance_source_id" UUID NOT NULL,
    "schedule_reference" TEXT NOT NULL,
    "month_covered" TEXT NOT NULL,
    "type" "credit"."ScheduleType" NOT NULL,
    "advice_id" UUID NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "control_total" BIGINT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "evidence_id" UUID NOT NULL,
    "checksum" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remittance_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."remittance_row" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "row_no" INTEGER NOT NULL,
    "row_type" TEXT NOT NULL,
    "member_id" UUID NOT NULL,
    "loan_id" UUID,
    "to_credit" BOOLEAN NOT NULL,
    "amount" BIGINT NOT NULL,
    "payment_date" DATE NOT NULL,
    "period_covered" TEXT,
    "receipt_no" TEXT,
    "note" TEXT,
    "row_hash" TEXT NOT NULL,
    "reversed_at" TIMESTAMPTZ(3),

    CONSTRAINT "remittance_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."lodgement" (
    "id" UUID NOT NULL,
    "schedule_id" UUID,
    "bank_account_id" UUID NOT NULL,
    "deposit_date" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "depositor" TEXT,
    "note" TEXT,
    "status" "credit"."LodgementStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "uniqueness_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lodgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_advice_remittance_source_id_advice_reference_key" ON "credit"."source_advice"("remittance_source_id", "advice_reference");

-- CreateIndex
CREATE UNIQUE INDEX "source_advice_row_advice_id_moaum_id_number_key" ON "credit"."source_advice_row"("advice_id", "moaum_id_number");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_schedule_advice_id_key" ON "credit"."remittance_schedule"("advice_id");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_schedule_remittance_source_id_schedule_reference_key" ON "credit"."remittance_schedule"("remittance_source_id", "schedule_reference");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_schedule_one_regular" ON "credit"."remittance_schedule"("remittance_source_id", "month_covered") WHERE (type = 'REGULAR');

-- CreateIndex
CREATE INDEX "remittance_row_loan_id_idx" ON "credit"."remittance_row"("loan_id");

-- CreateIndex
CREATE INDEX "remittance_row_member_id_idx" ON "credit"."remittance_row"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_row_schedule_id_row_no_key" ON "credit"."remittance_row"("schedule_id", "row_no");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_row_schedule_id_row_hash_key" ON "credit"."remittance_row"("schedule_id", "row_hash");

-- CreateIndex
CREATE UNIQUE INDEX "lodgement_uniqueness_key_key" ON "credit"."lodgement"("uniqueness_key");

-- AddForeignKey
ALTER TABLE "credit"."source_advice" ADD CONSTRAINT "source_advice_remittance_source_id_fkey" FOREIGN KEY ("remittance_source_id") REFERENCES "credit"."remittance_source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."source_advice_row" ADD CONSTRAINT "source_advice_row_advice_id_fkey" FOREIGN KEY ("advice_id") REFERENCES "credit"."source_advice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_schedule" ADD CONSTRAINT "remittance_schedule_remittance_source_id_fkey" FOREIGN KEY ("remittance_source_id") REFERENCES "credit"."remittance_source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_schedule" ADD CONSTRAINT "remittance_schedule_advice_id_fkey" FOREIGN KEY ("advice_id") REFERENCES "credit"."source_advice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_row" ADD CONSTRAINT "remittance_row_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "credit"."remittance_schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_row" ADD CONSTRAINT "remittance_row_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "credit"."member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_row" ADD CONSTRAINT "remittance_row_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "credit"."loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."lodgement" ADD CONSTRAINT "lodgement_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "credit"."remittance_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."lodgement" ADD CONSTRAINT "lodgement_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "credit"."bank_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
