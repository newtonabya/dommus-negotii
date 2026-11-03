-- Member profile change requests, approved by the Loan Officer (PRD F5).
BEGIN;

-- CreateEnum
CREATE TYPE "credit"."ProfileChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "credit"."profile_change_request" (
    "id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "changes" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "note" TEXT,
    "evidence_id" UUID,
    "phone_verified_at" TIMESTAMPTZ(3),
    "status" "credit"."ProfileChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,

    CONSTRAINT "profile_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_change_request_status_requested_at_idx" ON "credit"."profile_change_request"("status", "requested_at");

-- CreateIndex
CREATE INDEX "profile_change_request_member_id_requested_at_idx" ON "credit"."profile_change_request"("member_id", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_change_request_one_pending" ON "credit"."profile_change_request"("member_id") WHERE (status = 'PENDING');

-- AddForeignKey
ALTER TABLE "credit"."profile_change_request" ADD CONSTRAINT "profile_change_request_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "credit"."member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
