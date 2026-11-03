-- Scheduled job run log (PRD §5).
BEGIN;

-- CreateEnum
CREATE TYPE "shell"."JobRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "shell"."job_run" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "shell"."JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_run_job_started_at_idx" ON "shell"."job_run"("job", "started_at");


COMMIT;
