BEGIN;
-- AlterEnum
ALTER TYPE "credit"."ImportKind" ADD VALUE 'LEGACY_LOANS';

COMMIT;
