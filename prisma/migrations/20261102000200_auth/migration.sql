-- CreateTable
CREATE TABLE "shell"."user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "two_factor_enabled" BOOLEAN DEFAULT false,
    "phone_number" TEXT,
    "phone_number_verified" BOOLEAN,
    "deactivated_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."session" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shell"."two_factor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "verified" BOOLEAN DEFAULT true,
    "failed_verification_count" INTEGER DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "shell"."user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_phone_number_key" ON "shell"."user"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "shell"."session"("token");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "shell"."session"("user_id");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "shell"."account"("user_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "shell"."verification"("identifier");

-- CreateIndex
CREATE INDEX "two_factor_secret_idx" ON "shell"."two_factor"("secret");

-- CreateIndex
CREATE INDEX "two_factor_user_id_idx" ON "shell"."two_factor"("user_id");

-- AddForeignKey
ALTER TABLE "shell"."session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "shell"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shell"."account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "shell"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shell"."two_factor" ADD CONSTRAINT "two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "shell"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shell"."user_module_role" ADD CONSTRAINT "user_module_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "shell"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written additions ─────────────────────────────────────────────────────

-- Better Auth deletes expired/used rows in these tables (sign-out, used tokens,
-- disabling 2FA). Users themselves are never deleted: they are deactivated.
GRANT DELETE ON "shell"."session", "shell"."verification", "shell"."two_factor", "shell"."account" TO "app_runtime";

-- Modules that role assignments refer to (PRD F2). SHELL assignments apply portal-wide.
INSERT INTO "shell"."module" ("code", "name", "status", "event_types") VALUES
  ('SHELL', 'Portal Shell', 'LIVE', '{}'),
  ('CREDIT', 'Credit Super Store', 'LIVE', ARRAY['CASH_IN','CASH_OUT','PRINCIPAL_RECOVERY','INTEREST_INCOME','OPENING_BALANCE','DEPOSIT_CREDITED','DEPOSIT_REFUNDED','SCHEDULE_ACCEPTED','SCHEDULE_POSTED','LODGEMENT_BANK_VERIFIED','LODGEMENT_APPLIED','LODGEMENT_UNAPPLIED'])
ON CONFLICT ("code") DO NOTHING;
