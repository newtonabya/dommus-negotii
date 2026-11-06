BEGIN;

-- System-issued member numbers (MCS-NNNNN). Existing members are numbered in
-- the order they were created; new ones get the next number from the sequence.
CREATE SEQUENCE "credit"."member_no_seq";
GRANT USAGE ON SEQUENCE "credit"."member_no_seq" TO "app_runtime";

ALTER TABLE "credit"."member" ADD COLUMN "member_no" TEXT;
UPDATE "credit"."member" m
SET "member_no" = 'MCS-' || lpad(n.rn::text, 5, '0')
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "credit"."member") n
WHERE m."id" = n."id";
SELECT setval('"credit"."member_no_seq"', GREATEST((SELECT count(*) FROM "credit"."member"), 1), (SELECT count(*) > 0 FROM "credit"."member"));
ALTER TABLE "credit"."member" ALTER COLUMN "member_no" SET DEFAULT ('MCS-'::text || lpad((nextval('credit.member_no_seq'::regclass))::text, 5, '0'::text));
ALTER TABLE "credit"."member" ALTER COLUMN "member_no" SET NOT NULL;
ALTER SEQUENCE "credit"."member_no_seq" OWNED BY "credit"."member"."member_no";

-- The member's staff number on their remittance source's payroll.
ALTER TABLE "credit"."member" ADD COLUMN "payroll_staff_no" TEXT;

CREATE UNIQUE INDEX "member_member_no_key" ON "credit"."member"("member_no");
CREATE UNIQUE INDEX "member_remittance_source_id_payroll_staff_no_key" ON "credit"."member"("remittance_source_id", "payroll_staff_no");

COMMIT;
