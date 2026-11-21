# Module registration guide

How to add a new module (Modules 2–7) to the Dommus Negotii portal. The contracts it uses are described in [integration-contracts.md](integration-contracts.md); the Credit module (`src/modules/credit`) is the working example throughout.

The example module here is `SAVINGS` (Postgres schema `savings`). Replace the names with your own.

## The rules

1. **The module owns one Postgres schema** and keeps all its tables there. It never writes another module's tables or the `shell`, `ledger` and `evidence` tables directly: it goes through the contract functions.
2. **The module talks only to the contracts:** the Auth API, `postEvent` / `reverseEvent`, the Evidence API and the module registry, plus the shared services (audit, settings, notifications, exceptions, jobs).
3. **The dependency direction is one way.** `src/modules/savings` may import from `src/shell`, `src/ledger`, `src/evidence` and `src/lib`. Those never import from a module (enforced by ESLint).
4. **Money is `bigint` kobo, rates are basis points.** No floats.
5. **Every financial record has evidence, every change is audited, every server action is permission-checked**, and staff never act on their own records.

## Step 1. The database schema

Create a migration (`npx prisma migrate dev --create-only --name savings_foundation`) and write it between `BEGIN;` and `COMMIT;`. Prisma does not wrap migrations in a transaction, and a dropped Neon connection must not leave half a migration applied.

```sql
BEGIN;

CREATE SCHEMA IF NOT EXISTS "savings";

-- The app connects as app_runtime, never as the owner (PRD §5).
GRANT USAGE ON SCHEMA "savings" TO "app_runtime";
ALTER DEFAULT PRIVILEGES IN SCHEMA "savings" GRANT SELECT, INSERT, UPDATE ON TABLES TO "app_runtime";
ALTER DEFAULT PRIVILEGES IN SCHEMA "savings" GRANT USAGE ON SEQUENCES TO "app_runtime";

-- Your tables here ...

-- Register the module and the ledger event types it emits.
INSERT INTO "shell"."module" ("code", "name", "status", "event_types") VALUES
  ('SAVINGS', 'Savings', 'LIVE', ARRAY['CASH_IN','CASH_OUT','DEPOSIT_CREDITED'])
ON CONFLICT ("code") DO NOTHING;

COMMIT;
```

- Grant `DELETE` only where a table really needs it. Append-only tables (records of what happened) get an append-only trigger like `ledger_event_append_only` in migration `20261102000100_append_only_and_roles`.
- Add `"savings"` to `schemas` in the `datasource` block of `prisma/schema.prisma`, and put `@@schema("savings")` on each of your models.
- Link people by storing the portal `user_id` on your own records (as `credit.member.user_id` does), never by adding columns to `shell` tables.
- Run `npx prisma generate`, then apply the migration to each database before the release that needs it: `npx prisma migrate deploy` against the Neon `dev` and `test` branches, staging (`main`) and, at release time, production. See AGENTS.md, "Database" and "Branches and releases".

`registerModule(db, { code, name, eventTypes })` does the same as the `INSERT` and can be used instead, for example from a setup script. Registering again updates the name and event list and leaves the status alone.

## Step 2. New ledger event types (only if needed)

Use the existing event types where they fit (`CASH_IN`, `CASH_OUT`, `DEPOSIT_CREDITED`, `DEPOSIT_REFUNDED`, ...). If the module needs a new one:

1. In a migration: `ALTER TYPE "ledger"."LedgerEventType" ADD VALUE 'SAVINGS_INTEREST_ACCRUED';`. A value added this way can't be used in the same transaction, so do it in its own migration, before the one that registers the module.
2. Add it to `enum LedgerEventType` in `prisma/schema.prisma` and to `EVENT_TYPES` in `src/ledger/events.ts`. If it is a status event (no money), add it to `STATUS_EVENT_TYPES` too.
3. Add any rule it must follow to the `superRefine` in `newLedgerEventSchema`, as `INTEREST_INCOME` and `PRINCIPAL_RECOVERY` have.
4. Declare it in the module's `event_types`.
5. Add it to PRD F4's event table.

A new `source` works the same way (`LedgerSource`, `SOURCES`).

Changing `src/ledger` changes the contract for every module: keep the existing rules and tests (`tests/integration/append-only.test.ts`, `modules.test.ts`) passing.

## Step 3. Roles and permissions

1. Add the module code to `MODULE_CODES` in `src/shell/rbac/roles.ts`.
2. Add the module's actions to `PERMISSIONS` in `src/shell/rbac/permissions.ts`, each with its module code and the roles allowed, following PRD §3:

   ```ts
   "savings.deposit.record": p("SAVINGS", "CASHIER"),
   "savings.deposit.verify": p("SAVINGS", "FINANCE_MANAGER"),
   ```

3. Roles are shared across modules (the `Role` enum). A module that needs its own role adds it to `ROLES` and to the Postgres enum `"shell"."Role"` with a migration. Role assignments are rows in `shell.user_module_role` (user, module, role). The Admin's Users page assigns each role to the module that `moduleForRole` returns, which is either `SHELL` or `CREDIT` today. Before anyone can be given a `SAVINGS` role, extend `moduleForRole` and the Users page so the Admin can choose the module.
4. Add any new blocked role combinations to `BLOCKED_PAIRS`.

## Step 4. Module code

Lay the module out like Credit:

```
src/modules/savings/
├─ domain/        # pure logic, no I/O (dates, money calculations); unit-tested
├─ <feature>/     # services: take `db` and an actor, check state and self-dealing, write records, post events, audit
├─ notices.ts     # SMS/email texts for status messages
└─ reports/       # report definitions
```

A service function in outline:

```ts
export async function verifyDeposit(db: PrismaClient, actor: { id: string; ipAddress: string | null }, depositId: string) {
  return db.$transaction(async (tx) => {
    const deposit = await tx.savingsDeposit.findUniqueOrThrow({ where: { id: depositId } });
    if (deposit.recordedById === actor.id) throw new SavingsError("You recorded this deposit: someone else must verify it.");
    await assertNotOwnAccount(tx, deposit, actor);              // no self-dealing

    const { count } = await tx.savingsDeposit.updateMany({ where: { id: deposit.id, status: "RECORDED" }, data: { status: "VERIFIED", verifiedById: actor.id } });
    if (count === 0) throw new SavingsError("This deposit has already been dealt with.");
    await postEvent(tx, {
      occurredAt: deposit.valueDate,
      moduleCode: "SAVINGS",
      eventType: "CASH_IN",
      source: "BANK_SLIP",
      evidenceRefs: [deposit.evidenceId],
      portalUserId: actor.id,
      moduleEntityType: "SavingsDeposit",
      moduleEntityId: deposit.id,
      bankAccountId: deposit.bankAccountId,
      cashAmount: deposit.amount,
      uniquenessKey: `SAVINGS:DEPOSIT:${deposit.id}`,
    });
    await writeAudit(tx, { action: "savings.deposit.verified", entityType: "SavingsDeposit", entityId: deposit.id, userId: actor.id, ipAddress: actor.ipAddress });
    await queueForUser(tx, depositorUserId, { key: `savings.deposit.verified:${deposit.id}`, template: "savings.deposit.verified", subject: "Deposit received", text: "..." });
  }, TX_OPTIONS);
}
```

- Do every write of one action in one transaction (`TX_OPTIONS`), so the ledger, the audit trail and the queued messages commit together.
- Update with `updateMany` and the expected current status in the `where`, then check the count (as `moveLoan` does), so two people acting at once can't both succeed.
- Prefix every `uniquenessKey`, exception `dedupeKey` and notice `key` with the module code.
- Give the module its own error class for messages that are safe to show to users, and add it to `messageOf` in `src/app/(staff)/staff/run-action.ts`.
- Limits and rates are settings (`src/shell/settings/definitions.ts`), never constants.

## Step 5. Pages and server actions

- Staff pages go under `src/app/(staff)/staff/<area>/`; member pages under `src/app/(member)/member/<area>/`.
- Every staff page starts with `requireStaffPermission(action)`. Every server action starts with `authorizeAction(action)` and runs its work through `runAndReturn` / `runForResult` (`src/app/(staff)/staff/run-action.ts`), which shows the result and sends queued messages right away.
- Add menu entries to `groups` in `src/app/(staff)/staff/layout.tsx` (each entry shown only to users who `can(...)` its action), and keep `MENU` in `scripts/demo/make-testing-guide.py` in the same order.
- Add a line to `workQueue` (`src/modules/credit/reports/work-queue.ts`) for each new approval step, so it appears under "Waiting for you" and as a menu badge.
- New HTTP endpoints go under `src/app/api/v1/` and into [api/openapi.yaml](api/openapi.yaml).

## Step 6. Dashboard, reports, jobs

- **GMD dashboard:** revenue is `sum(revenue_amount)` per module. `gmdDashboard` (`src/modules/credit/reports/dashboard.ts`) queries `CREDIT` only today: add the new module's revenue and leaderboard there (PRD F14).
- **Reports:** add definitions like those in `src/modules/credit/reports/staff-reports.ts`. Each renders on screen and exports to Excel and PDF, and its totals must tie back to ledger sums (`tests/integration/reports.test.ts` shows how).
- **Jobs:** add to `JOBS` in `src/jobs/definitions.ts`. Jobs must be idempotent and work in small batches, so the Neon Free plan database can sleep in between.
- **Reconciliation:** cash events with a `bankAccountId` take part in the Credit bank reconciliation (`accountPosition`). A module that moves money through MOAUM's bank accounts must tie each cash event to its statement line, as Credit does.

## Step 7. Tests

- Pure logic: unit tests in `tests/unit/`.
- Services: integration tests in `tests/integration/` against the Neon `test` branch (`TEST_DATABASE_URL`). Test rows can't be deleted (append-only), so use random ids and dates far in the future. To start clean, reset the `test` branch from `main`.
- A test that changes a module's status registers its own throwaway module (see `tests/integration/modules.test.ts`), never a real one.
- Cover the role checks and the self-dealing checks for every action.
- `npm run lint`, `npm run typecheck` and `npm test` must pass in CI.

## Checklist

- [ ] Migration in `BEGIN;` … `COMMIT;`: schema, `app_runtime` grants, module registered with its event types
- [ ] `schemas` in `prisma/schema.prisma`, `@@schema` on every model
- [ ] Any new event types, sources or roles added to the Postgres enums, the Prisma enums and the TypeScript lists
- [ ] Module code in `MODULE_CODES`, actions in `PERMISSIONS`, role assignment possible on the Users page
- [ ] Every server action calls `authorizeAction`; every page calls `requireStaffPermission`
- [ ] Self-dealing and maker-checker checks in the services
- [ ] Ledger keys, exception keys and notice keys prefixed with the module code
- [ ] Evidence linked for every financial record
- [ ] Menu, work queue, dashboard and reports updated
- [ ] Tests for logic, roles and self-dealing; CI green
- [ ] Migrations applied to dev, test and staging; production before the release
- [ ] `docs/api/openapi.yaml`, AGENTS.md and the PRD updated
