BEGIN;
-- Arrears at go-live for legacy loans: what a member was already behind by on
-- the go-live date. The principal part is inside amount_approved (what was
-- still owed); the interest part is owed on top. Both are due on d0, so they
-- show as overdue from day one and are cleared first by repayments.
ALTER TABLE "credit"."loan"
  ADD COLUMN "opening_arrears_principal" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "opening_arrears_interest" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "credit"."loan"
  ADD CONSTRAINT "loan_opening_arrears_not_negative" CHECK ("opening_arrears_principal" >= 0 AND "opening_arrears_interest" >= 0),
  ADD CONSTRAINT "loan_opening_arrears_within_principal" CHECK ("amount_approved" IS NULL OR "opening_arrears_principal" <= "amount_approved");
COMMIT;
