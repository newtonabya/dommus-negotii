BEGIN;
-- CreateTable
CREATE TABLE "credit"."reconciliation_run" (
    "id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "run_by_id" TEXT NOT NULL,
    "run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "results" JSONB NOT NULL,

    CONSTRAINT "reconciliation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit"."period_close" (
    "month" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "closed_by_id" TEXT NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshots" JSONB NOT NULL,
    "ledger_totals" JSONB NOT NULL,

    CONSTRAINT "period_close_pkey" PRIMARY KEY ("month")
);

-- CreateIndex
CREATE INDEX "reconciliation_run_month_run_at_idx" ON "credit"."reconciliation_run"("month", "run_at");

COMMIT;
