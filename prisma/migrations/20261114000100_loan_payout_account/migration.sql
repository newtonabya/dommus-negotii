BEGIN;
-- The applicant's bank details, given on the loan application; the payout voucher starts from them.
ALTER TABLE "credit"."loan" ADD COLUMN "payout_bank" TEXT,
ADD COLUMN "payout_account_no" TEXT,
ADD COLUMN "payout_account_name" TEXT;
COMMIT;
