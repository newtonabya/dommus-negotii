BEGIN;
-- Why a disbursement pays a different account from the one the member gave on the application.
ALTER TABLE "credit"."voucher" ADD COLUMN "account_change_reason" TEXT;
COMMIT;
