BEGIN;
-- One payroll row split across a member's active loans (oldest first); not a schedule row.
-- CreateTable
CREATE TABLE "credit"."remittance_row_split" (
    "id" UUID NOT NULL,
    "row_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "remittance_row_split_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "remittance_row_split_loan_id_idx" ON "credit"."remittance_row_split"("loan_id");

-- CreateIndex
CREATE UNIQUE INDEX "remittance_row_split_row_id_loan_id_key" ON "credit"."remittance_row_split"("row_id", "loan_id");

-- AddForeignKey
ALTER TABLE "credit"."remittance_row_split" ADD CONSTRAINT "remittance_row_split_row_id_fkey" FOREIGN KEY ("row_id") REFERENCES "credit"."remittance_row"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."remittance_row_split" ADD CONSTRAINT "remittance_row_split_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "credit"."loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
