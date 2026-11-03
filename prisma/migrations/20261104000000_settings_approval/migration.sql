-- Financial settings with Management approval (PRD F2, AT-r).
BEGIN;

-- A proposer can take back a proposal before it is decided.
ALTER TYPE "shell"."ChangeRequestStatus" ADD VALUE 'WITHDRAWN';

-- Several changes may share an effective date (e.g. two operational changes on
-- one day); the latest by created_at wins, so (key, effective_from) is no longer unique.
DROP INDEX "shell"."setting_key_effective_from_key";
CREATE INDEX "setting_key_effective_from_created_at_idx" ON "shell"."setting"("key", "effective_from", "created_at");

-- At most one open proposal per setting.
CREATE UNIQUE INDEX "setting_change_request_one_pending" ON "shell"."setting_change_request"("key") WHERE (status = 'PENDING');

COMMIT;
