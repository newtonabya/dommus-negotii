BEGIN;
-- Member numbers become MOAUM/0001, MOAUM/0002, ... and the separate MOAUM ID
-- card number is retired: the column stays as an internal copy of the number.

CREATE FUNCTION "credit"."next_member_no"() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  n := nextval('credit.member_no_seq');
  RETURN 'MOAUM/' || lpad(n::text, GREATEST(4, length(n::text)), '0');
END $$;
GRANT EXECUTE ON FUNCTION "credit"."next_member_no"() TO "app_runtime";
ALTER TABLE "credit"."member" ALTER COLUMN "member_no" SET DEFAULT "credit"."next_member_no"();

-- Renumber the members already here, oldest first.
CREATE TEMP TABLE "renum" ON COMMIT DROP AS
SELECT "id", "moaum_id_number" AS "old_id",
       'MOAUM/' || lpad(n::text, GREATEST(4, length(n::text)), '0') AS "new_no"
FROM (SELECT "id", "moaum_id_number", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "credit"."member") o;

UPDATE "credit"."source_advice_row" r SET "moaum_id_number" = n."new_no" FROM "renum" n WHERE upper(r."moaum_id_number") = upper(n."old_id");
UPDATE "credit"."guarantor" g SET "moaum_id_number" = n."new_no" FROM "renum" n WHERE g."member_id" = n."id";
UPDATE "credit"."member" SET "member_no" = 'TMP-' || "id", "moaum_id_number" = 'TMP-' || "id";
UPDATE "credit"."member" m SET "member_no" = n."new_no", "moaum_id_number" = n."new_no" FROM "renum" n WHERE m."id" = n."id";
SELECT setval('"credit"."member_no_seq"', GREATEST((SELECT count(*) FROM "credit"."member"), 1), (SELECT count(*) > 0 FROM "credit"."member"));
ALTER TABLE "credit"."member" ADD COLUMN "department" TEXT;

-- A member guarantor accepts by a personal SMS link.
ALTER TABLE "credit"."guarantor" ADD COLUMN "acceptance" TEXT,
ADD COLUMN "accept_token_hash" TEXT,
ADD COLUMN "requested_at" TIMESTAMPTZ(3),
ADD COLUMN "responded_at" TIMESTAMPTZ(3),
ADD COLUMN "accept_expires_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "guarantor_accept_token_hash_key" ON "credit"."guarantor"("accept_token_hash");
COMMIT;
