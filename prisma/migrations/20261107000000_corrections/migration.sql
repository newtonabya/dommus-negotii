BEGIN;

-- CreateEnum
CREATE TYPE "credit"."CorrectionStatus" AS ENUM ('PREPARED', 'VERIFIED', 'RETURNED');

-- DropIndex
DROP INDEX "credit"."remittance_row_schedule_id_row_hash_key";

-- AlterTable
ALTER TABLE "credit"."source_advice" ADD COLUMN     "supersede_reason" TEXT,
ADD COLUMN     "supersedes_id" UUID;

-- AlterTable
ALTER TABLE "credit"."remittance_row" ADD COLUMN     "correction_id" UUID,
ADD COLUMN     "reversed_by_correction_id" UUID;

-- CreateTable
CREATE TABLE "credit"."correction_batch" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "status" "credit"."CorrectionStatus" NOT NULL DEFAULT 'PREPARED',
    "reason" TEXT NOT NULL,
    "evidence_id" UUID NOT NULL,
    "advice_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "prepared_by_id" TEXT NOT NULL,
    "prepared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "return_comment" TEXT,

    CONSTRAINT "correction_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "correction_batch_schedule_id_prepared_at_idx" ON "credit"."correction_batch"("schedule_id", "prepared_at");

-- CreateIndex
CREATE UNIQUE INDEX "correction_batch_one_prepared" ON "credit"."correction_batch"("schedule_id") WHERE (status = 'PREPARED');

-- CreateIndex
CREATE UNIQUE INDEX "source_advice_supersedes_id_key" ON "credit"."source_advice"("supersedes_id");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_row_live_hash" ON "credit"."remittance_row"("schedule_id", "row_hash") WHERE (reversed_at IS NULL);

-- AddForeignKey
ALTER TABLE "credit"."source_advice" ADD CONSTRAINT "source_advice_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "credit"."source_advice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_row" ADD CONSTRAINT "remittance_row_reversed_by_correction_id_fkey" FOREIGN KEY ("reversed_by_correction_id") REFERENCES "credit"."correction_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_row" ADD CONSTRAINT "remittance_row_correction_id_fkey" FOREIGN KEY ("correction_id") REFERENCES "credit"."correction_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."correction_batch" ADD CONSTRAINT "correction_batch_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "credit"."remittance_schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."correction_batch" ADD CONSTRAINT "correction_batch_advice_id_fkey" FOREIGN KEY ("advice_id") REFERENCES "credit"."source_advice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
