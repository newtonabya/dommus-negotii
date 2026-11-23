BEGIN;
-- Member messages: a copy of each status message (never a code or a link), so a
-- member can read it on their Home page even when no SMS or email reached them
-- (e.g. SMS switched off and no email). Default grants give the app select,
-- insert and update; nothing deletes these rows.
CREATE TABLE "shell"."user_message" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "subject" TEXT,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_message_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_message_key_key" ON "shell"."user_message"("key");
CREATE INDEX "user_message_user_id_created_at_idx" ON "shell"."user_message"("user_id", "created_at");
COMMIT;
