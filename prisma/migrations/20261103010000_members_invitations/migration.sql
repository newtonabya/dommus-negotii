-- CreateEnum
CREATE TYPE "credit"."InvitationType" AS ENUM ('REGISTRATION', 'ACTIVATION');

-- CreateEnum
CREATE TYPE "credit"."MemberStatus" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED', 'EXITED');

-- CreateTable
CREATE TABLE "credit"."remittance_source" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remittance_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."invitation" (
    "id" UUID NOT NULL,
    "type" "credit"."InvitationType" NOT NULL DEFAULT 'REGISTRATION',
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "remittance_source_id" UUID,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "last_send_ok" BOOLEAN NOT NULL DEFAULT true,
    "opened_at" TIMESTAMPTZ(3),
    "registered_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" TEXT,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."member" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT NOT NULL,
    "moaum_id_number" TEXT NOT NULL,
    "id_scan_evidence_id" UUID,
    "next_of_kin_name" TEXT NOT NULL,
    "next_of_kin_phone" TEXT NOT NULL,
    "remittance_source_id" UUID,
    "status" "credit"."MemberStatus" NOT NULL DEFAULT 'PENDING',
    "consent_at" TIMESTAMPTZ(3) NOT NULL,
    "consent_version" TEXT NOT NULL,
    "invitation_id" UUID,
    "invited_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "decline_reason" TEXT,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "remittance_source_code_key" ON "credit"."remittance_source"("code");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "credit"."invitation"("token_hash");

-- CreateIndex
CREATE INDEX "invitation_phone_created_at_idx" ON "credit"."invitation"("phone", "created_at");

-- CreateIndex
CREATE INDEX "invitation_sent_by_id_created_at_idx" ON "credit"."invitation"("sent_by_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "member_user_id_key" ON "credit"."member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_phone_key" ON "credit"."member"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "member_moaum_id_number_key" ON "credit"."member"("moaum_id_number");

-- CreateIndex
CREATE UNIQUE INDEX "member_invitation_id_key" ON "credit"."member"("invitation_id");

-- CreateIndex
CREATE INDEX "member_status_created_at_idx" ON "credit"."member"("status", "created_at");

-- AddForeignKey
ALTER TABLE "credit"."invitation" ADD CONSTRAINT "invitation_remittance_source_id_fkey" FOREIGN KEY ("remittance_source_id") REFERENCES "credit"."remittance_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."member" ADD CONSTRAINT "member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "shell"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."member" ADD CONSTRAINT "member_remittance_source_id_fkey" FOREIGN KEY ("remittance_source_id") REFERENCES "credit"."remittance_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit"."member" ADD CONSTRAINT "member_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "credit"."invitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
