-- Hand-written: database-level guarantees Prisma cannot express (PRD F2, F3, F4, §5).

CREATE SCHEMA IF NOT EXISTS "credit";

-- ── Ledger rules ────────────────────────────────────────────────────────────

-- Every event carries evidence.
ALTER TABLE "ledger"."ledger_event"
  ADD CONSTRAINT "ledger_event_has_evidence" CHECK (cardinality("evidence_refs") >= 1);

-- Originals carry non-negative amounts; reversals carry the negatives.
ALTER TABLE "ledger"."ledger_event"
  ADD CONSTRAINT "ledger_event_sign" CHECK (
    ("reverses_event_id" IS NULL AND "cash_amount" >= 0 AND "revenue_amount" >= 0 AND "deposit_delta" >= 0
       AND "principal_amount" >= 0 AND "interest_amount" >= 0 AND "retention_amount" >= 0)
    OR
    ("reverses_event_id" IS NOT NULL AND "cash_amount" <= 0 AND "revenue_amount" <= 0 AND "deposit_delta" <= 0
       AND "principal_amount" <= 0 AND "interest_amount" <= 0 AND "retention_amount" <= 0)
  );

ALTER TABLE "ledger"."ledger_event"
  ADD CONSTRAINT "ledger_event_currency" CHECK ("currency" = 'NGN');

-- A reversal must exactly negate the event it reverses.
CREATE FUNCTION "ledger"."check_reversal"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o "ledger"."ledger_event";
BEGIN
  IF NEW."reverses_event_id" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM "ledger"."ledger_event" WHERE "event_id" = NEW."reverses_event_id";
  IF o."reverses_event_id" IS NOT NULL THEN
    RAISE EXCEPTION 'A reversal cannot itself be reversed';
  END IF;
  IF NEW."cash_amount" <> -o."cash_amount" OR NEW."revenue_amount" <> -o."revenue_amount"
     OR NEW."deposit_delta" <> -o."deposit_delta" OR NEW."principal_amount" <> -o."principal_amount"
     OR NEW."interest_amount" <> -o."interest_amount" OR NEW."retention_amount" <> -o."retention_amount"
     OR NEW."event_type" <> o."event_type" OR NEW."module_code" <> o."module_code" THEN
    RAISE EXCEPTION 'Reversal % does not exactly negate event %', NEW."event_id", o."event_id";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ledger_event_check_reversal"
  BEFORE INSERT ON "ledger"."ledger_event"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."check_reversal"();

-- ── Append-only tables ──────────────────────────────────────────────────────
-- Blocks UPDATE, DELETE and TRUNCATE for every role, including the owner.

CREATE FUNCTION "shell"."reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "shell"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "shell"."reject_change"();
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "shell"."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "shell"."reject_change"();

CREATE TRIGGER "ledger_event_append_only" BEFORE UPDATE OR DELETE ON "ledger"."ledger_event"
  FOR EACH ROW EXECUTE FUNCTION "shell"."reject_change"();
CREATE TRIGGER "ledger_event_no_truncate" BEFORE TRUNCATE ON "ledger"."ledger_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "shell"."reject_change"();

CREATE TRIGGER "evidence_file_append_only" BEFORE UPDATE OR DELETE ON "evidence"."evidence_file"
  FOR EACH ROW EXECUTE FUNCTION "shell"."reject_change"();
CREATE TRIGGER "evidence_file_no_truncate" BEFORE TRUNCATE ON "evidence"."evidence_file"
  FOR EACH STATEMENT EXECUTE FUNCTION "shell"."reject_change"();

CREATE TRIGGER "evidence_link_append_only" BEFORE UPDATE OR DELETE ON "evidence"."evidence_link"
  FOR EACH ROW EXECUTE FUNCTION "shell"."reject_change"();
CREATE TRIGGER "evidence_link_no_truncate" BEFORE TRUNCATE ON "evidence"."evidence_link"
  FOR EACH STATEMENT EXECUTE FUNCTION "shell"."reject_change"();

CREATE TRIGGER "setting_append_only" BEFORE UPDATE OR DELETE ON "shell"."setting"
  FOR EACH ROW EXECUTE FUNCTION "shell"."reject_change"();

-- ── Runtime role ────────────────────────────────────────────────────────────
-- The app connects as app_runtime. Its password is set once by hand
-- (ALTER ROLE app_runtime WITH LOGIN PASSWORD '...'), never in a migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE "app_runtime" NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA "shell", "ledger", "evidence", "credit" TO "app_runtime";

-- Append-only tables: read and insert only.
GRANT SELECT, INSERT ON "shell"."audit_log", "shell"."setting",
  "ledger"."ledger_event", "evidence"."evidence_file", "evidence"."evidence_link" TO "app_runtime";

-- Working tables in shell.
GRANT SELECT, INSERT, UPDATE ON "shell"."module", "shell"."user_module_role",
  "shell"."setting_change_request", "shell"."notification" TO "app_runtime";

-- Future tables: read, insert and update by default; never delete. Tables that
-- must be append-only get their own trigger and a REVOKE UPDATE in their migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA "shell", "credit" GRANT SELECT, INSERT, UPDATE ON TABLES TO "app_runtime";
ALTER DEFAULT PRIVILEGES IN SCHEMA "ledger", "evidence" GRANT SELECT, INSERT ON TABLES TO "app_runtime";
ALTER DEFAULT PRIVILEGES IN SCHEMA "shell", "ledger", "evidence", "credit" GRANT USAGE ON SEQUENCES TO "app_runtime";
