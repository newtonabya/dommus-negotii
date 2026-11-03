-- Wrapped in a transaction so a dropped connection can't leave it half-applied.
BEGIN;

-- CreateEnum
CREATE TYPE "credit"."ImportKind" AS ENUM ('MEMBERS', 'INVITATIONS');

-- CreateEnum
CREATE TYPE "credit"."ImportStatus" AS ENUM ('PREVIEWED', 'COMMITTED', 'REJECTED');

-- AlterTable
ALTER TABLE "credit"."member" ALTER COLUMN "consent_at" DROP NOT NULL,
ALTER COLUMN "consent_version" DROP NOT NULL;

-- CreateTable
CREATE TABLE "credit"."import_batch" (
    "id" UUID NOT NULL,
    "kind" "credit"."ImportKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "evidence_id" UUID,
    "row_count" INTEGER NOT NULL,
    "error_row_count" INTEGER NOT NULL,
    "status" "credit"."ImportStatus" NOT NULL DEFAULT 'PREVIEWED',
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_by_id" TEXT,
    "committed_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."import_row_log" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_no" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "errors" TEXT[],
    "entity_id" TEXT,

    CONSTRAINT "import_row_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batch_kind_uploaded_at_idx" ON "credit"."import_batch"("kind", "uploaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_row_log_batch_id_row_no_key" ON "credit"."import_row_log"("batch_id", "row_no");

-- AddForeignKey
ALTER TABLE "credit"."import_row_log" ADD CONSTRAINT "import_row_log_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "credit"."import_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
