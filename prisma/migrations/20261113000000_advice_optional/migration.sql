BEGIN;
-- DropForeignKey
ALTER TABLE "credit"."remittance_schedule" DROP CONSTRAINT "remittance_schedule_advice_id_fkey";

-- DropForeignKey
ALTER TABLE "credit"."correction_batch" DROP CONSTRAINT "correction_batch_advice_id_fkey";

-- AlterTable
ALTER TABLE "credit"."remittance_schedule" ALTER COLUMN "advice_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "credit"."correction_batch" ALTER COLUMN "advice_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "credit"."remittance_schedule" ADD CONSTRAINT "remittance_schedule_advice_id_fkey" FOREIGN KEY ("advice_id") REFERENCES "credit"."source_advice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."correction_batch" ADD CONSTRAINT "correction_batch_advice_id_fkey" FOREIGN KEY ("advice_id") REFERENCES "credit"."source_advice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
