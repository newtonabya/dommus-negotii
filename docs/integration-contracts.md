# Integration contracts

Phase 1 delivers the Credit Super Store (module `CREDIT`) and the shared layers every later module (Modules 2–7) builds on. This document describes the four contracts a new module uses (PRD §8). A module talks to the portal only through these contracts, owns its own Postgres schema, and never reads or writes another module's tables.

How to plug a new module in, step by step: [module-registration-guide.md](module-registration-guide.md). HTTP endpoints: [api/openapi.yaml](api/openapi.yaml).

| Contract | Code | Summary |
|---|---|---|
| 1. Auth API | `src/shell/auth/session.ts`, `src/shell/rbac/` | Who is signed in, what they may do, no self-dealing |
| 2. Ledger event schema | `src/ledger/events.ts`, `src/ledger/post.ts` | `postEvent()` / `reverseEvent()`, schema version 2 |
| 3. Evidence API | `src/evidence/service.ts` | Upload, link, open with checksum check, duplicate flag |
| 4. Module registration | `src/shell/registry/registry.ts` | Module code, status, declared event types |

Shared rules for all four:

- **Database handle.** Every function takes `db: Db` (`src/lib/db.ts`): either the Prisma client from `getDb()` or a transaction client. Pass the transaction client so the contract's writes (ledger, audit, links, notices) commit or roll back with yours. Interactive transactions pass `TX_OPTIONS` (Neon needs more than Prisma's 5-second default).
- **Money** is integer kobo as `bigint`, rates are basis points (`src/lib/money.ts`). Never use `number` for money: a lint rule and `tests/unit/no-float-money.test.ts` enforce it in money code.
- **Dates.** Business dates are Lagos calendar dates (`LocalDate`, `src/lib/dates.ts`, `todayInLagos()`).
- **Append-only.** Ledger events, audit rows, evidence files and links, and settings can't be updated or deleted, even by the database owner (triggers in migration `20261102000100_append_only_and_roles`). Corrections are new rows.
- **Dependency direction.** Modules import from `src/shell`, `src/ledger`, `src/evidence` and `src/lib`. Those shared layers never import from `src/modules/*` (ESLint `no-restricted-imports`).

---

## 1. Auth API

Sign-in is Better Auth (`src/shell/auth/auth.ts`). Staff sign in with email and must use two-factor (TOTP); members sign in with phone or email. A module never handles passwords or sessions itself.

### Session lookup

```ts
import { loadCurrentUser, requireUser, requireStaff, requireStaffPermission, authorizeAction } from "@/shell/auth/session";
```

| Function | Use in | On failure |
|---|---|---|
| `loadCurrentUser()` | Route handlers | Returns `{ problem: "signed-out" \| "idle" \| "deactivated" }` |
| `requireUser()` | Pages for any signed-in user | Redirects to `/sign-in` |
| `requireStaff()` | Staff pages | Redirects to `/forbidden`, or `/two-factor/setup` without 2FA |
| `requireStaffPermission(action)` | Staff pages that need one action | Redirects to `/forbidden` |
| `authorizeAction(action)` | **Every server action** | Throws `ForbiddenError` (status 403); the refusal is audited (`auth.forbidden`) |

`loadCurrentUser()` deletes the session of a deactivated user and ends an idle one (30 minutes for staff, 60 for members, `src/shell/auth/security.ts`). It reads without refreshing the session, so activity is only what the user actually did.

The user object (`CurrentUser`):

```ts
{
  id: string;               // portal user id: use it as the actor everywhere
  name: string;
  email: string;
  phoneNumber: string | null;
  twoFactorEnabled: boolean;
  assignments: { moduleCode: ModuleCode; role: Role }[];  // active role assignments
  isStaff: boolean;         // any role other than MEMBER
  sessionId: string;
  ipAddress: string | null; // for the audit trail
}
```

`authorizeAction` also refuses every action of a module whose status is `OFFLINE` (see contract 4). Role checks belong in the server action, never only in the UI.

### `hasPermission(user, module, action)`

```ts
import { hasPermission, assertPermission, PERMISSIONS, type Action } from "@/shell/rbac/permissions";

hasPermission(user.assignments, "loan.approve");   // boolean
assertPermission(user.assignments, "loan.approve"); // throws ForbiddenError
```

The permissions matrix `PERMISSIONS` (PRD §3) maps each action name to the module it belongs to and the roles that may perform it. The module is part of the action's definition, so a call names only the action. A role assignment counts if its module matches the action's module, or if it is a portal-wide (`SHELL`) assignment.

- Roles (`src/shell/rbac/roles.ts`): `MEMBER`, `TREASURER`, `FINANCE_MANAGER`, `CASHIER`, `LOAN_OFFICER`, `MANAGEMENT`, `AUDITOR`, `ADMIN`, `GMD`, `SECRETARY`. Every role except `MEMBER` is a staff role and needs two-factor login.
- `ADMIN`, `GMD`, `AUDITOR`, `SECRETARY` and `MANAGEMENT` are assigned on `SHELL` (portal-wide); the others on their module.
- Blocked role combinations (`roleCombinationViolations`): Cashier + Finance Manager, Treasurer + Finance Manager, Management + Cashier, Management + Loan Officer, Secretary + Loan Officer; GMD and Admin can't hold any other staff role.

### User-to-entity linking

A portal user is linked to a module's own record by storing the portal `user_id` on that record. Credit does this with `credit.member.user_id`: a member's login is the user whose id is on their member row. A new module links its own entities the same way (a `user_id` column in its own schema) and never adds columns to `shell` tables.

A staff user may also be a member (they hold both a staff role and a member record). This link is what the self-dealing check reads.

### Self-dealing check

Staff never act on their own records (PRD §3).

```ts
import { assertNotSelfDealing } from "@/shell/rbac/permissions";

assertNotSelfDealing(actorMemberId, subjectMemberId); // throws ForbiddenError when equal
```

Pass the member id linked to the acting user (or `null`) and the member the record belongs to. Credit's own form of the check is `assertNotOwnLoan` (`src/modules/credit/loans/common.ts`), which compares the loan's member `user_id` with the actor's id. A module applies it in every function that changes a record belonging to a person: approving, verifying, paying out, refunding.

Other separation rules sit in the module's own functions: the preparer of a voucher can't verify it, and nobody approves their own proposal.

---

## 2. Ledger event schema

The shared ledger (`ledger.ledger_event`) is the single record of money for every module. It is append-only and idempotent. Schema version: **2** (`SCHEMA_VERSION`).

### Posting

```ts
import { postEvent, reverseEvent, LedgerError } from "@/ledger/post";

const { event, created } = await postEvent(tx, {
  occurredAt: new Date("2026-11-03"),     // business date (payment date, value date, statement date)
  moduleCode: "CREDIT",
  eventType: "CASH_OUT",
  source: "DISBURSEMENT_VOUCHER",
  evidenceRefs: [evidenceId],             // at least one evidence file id
  portalUserId: user.id,                  // who caused it ("system" for jobs and recomputes)
  moduleEntityType: "Loan",
  moduleEntityId: loan.id,
  bankAccountId: account.id,              // or null
  cashAmount: 10_000_000n,                // kobo
  principalAmount: 10_000_000n,
  uniquenessKey: `CREDIT:DISBURSE:${voucher.id}`,
  metadata: { voucherId: voucher.id },
});
```

`postEvent` validates the input with `newLedgerEventSchema` (Zod), checks the module (registered, not `OFFLINE`, has declared this event type), then inserts. `posted_at` (system time), `currency` (`NGN`) and `schema_version` are set for you.

### Fields

| Field | Type | Rule |
|---|---|---|
| `occurredAt` | Date | Business date |
| `moduleCode` | string | A registered module |
| `eventType` | enum | See the table below; must be declared by the module |
| `source` | enum | `REMITTANCE_SCHEDULE`, `BANK_SLIP`, `BANK_STATEMENT`, `DISBURSEMENT_VOUCHER`, `REFUND_VOUCHER`, `LEGACY_IMPORT`. Reserved, refused in Phase 1: `RECEIPT_ENTRY`, `EXCEL_BATCH`, `LIVE_PAYMENT` |
| `evidenceRefs` | uuid[] | At least one (also a database check constraint) |
| `portalUserId` | string | Acting user id, or `system` |
| `moduleEntityType`, `moduleEntityId` | string | The module's own record |
| `bankAccountId` | string \| null | Set on cash events |
| `cashAmount` | bigint | Money moving through a bank account |
| `revenueAmount` | bigint | Recognised revenue (the GMD dashboard sums this per module) |
| `depositDelta` | bigint | Money held for a member (Overpayment Credits) |
| `principalAmount` | bigint | Principal lent or recovered |
| `interestAmount` | bigint | Interest earned |
| `retentionAmount` | bigint | Reserved for later modules |
| `uniquenessKey` | string ≤ 300 | Unique across the ledger |
| `metadata` | object | Free-form JSON; status events carry their amount here |

### Sign convention

- **Original events carry positive amounts.** The event type gives the direction (`CASH_IN` vs `CASH_OUT`). A negative amount on an original is refused.
- **A reversal carries the exact negatives** of the original, the same event type, entity and bank account, and sets `reverses_event_id`. A reversal can't itself be reversed, and an event can be reversed only once.
- **Status events** (`SCHEDULE_ACCEPTED`, `SCHEDULE_POSTED`, `LODGEMENT_BANK_VERIFIED`, `LODGEMENT_APPLIED`, `LODGEMENT_UNAPPLIED`) carry zero in every money field, so they can never double-count; their amount goes in `metadata.amount`.
- `INTEREST_INCOME` must have `revenueAmount = interestAmount`. `PRINCIPAL_RECOVERY` must have `revenueAmount = 0`: principal is never revenue.

### Phase 1 event types

| Event type | Money fields | Meaning |
|---|---|---|
| `OPENING_BALANCE` | `principalAmount` (loan) or `cashAmount` + bank account | Go-live balance |
| `CASH_IN` | `cashAmount`, bank account | Verified money in |
| `CASH_OUT` | `cashAmount`, bank account (+ `principalAmount` for a disbursement) | Verified money out |
| `PRINCIPAL_RECOVERY` | `principalAmount` | Principal repaid |
| `INTEREST_INCOME` | `interestAmount` = `revenueAmount` | Interest earned |
| `DEPOSIT_CREDITED` | `depositDelta` | Overpayment Credit created |
| `DEPOSIT_REFUNDED` | `depositDelta` | Overpayment Credit refunded |
| `SCHEDULE_ACCEPTED`, `SCHEDULE_POSTED` | none | Remittance schedule status |
| `LODGEMENT_BANK_VERIFIED`, `LODGEMENT_APPLIED`, `LODGEMENT_UNAPPLIED` | none | Lodgement status |
| `BANK_DEPOSIT` | — | Reserved, refused in Phase 1 |

The full rules for when Credit posts each one are in PRD F4.

### Idempotency

- `uniquenessKey` is unique. Posting the same key again **returns the existing event** with `created: false`; nothing is inserted and the surrounding transaction is not aborted (the insert uses `ON CONFLICT DO NOTHING`).
- Reusing a key for a *different* effect (another event type, entity, reversal target or amount) throws `LedgerError`: that is a bug in the caller.
- Build keys from the module code, the business key and, where a record can be re-posted after a recompute, a sequence or trigger: for example `CREDIT:ALLOC:<row>:<kind>:<k>:<amount>:<trigger>`, `CREDIT:REV:<eventId>`. Always prefix with the module code so keys never collide between modules.

### Reversing

```ts
await reverseEvent(tx, originalEventId, {
  uniquenessKey: `CREDIT:REV:${originalEventId}`,
  occurredAt: new Date("2026-11-21"),
  portalUserId: user.id,
  evidenceRefs: [evidenceId],   // at least one
  reason: "Posted to the wrong loan",
});
```

Reversals are idempotent on their key in the same way. The module must not be `OFFLINE`.

### Reading

Read with Prisma (`db.ledgerEvent`), filtering on `moduleCode`. A figure is always the sum of originals and their reversals (net). Revenue for a module is `sum(revenue_amount)` over its events.

---

## 3. Evidence API

Every financial record has evidence (PRD F3). Files are PDF, JPG, PNG, XLSX or CSV, at most 10 MB; the real type is read from the file's bytes, not its name. Files are kept for 7 years and never deleted. There is no delete endpoint.

```ts
import { beginUpload, finishUpload, storeEvidenceBytes, linkEvidence, openEvidence, EvidenceError, DuplicateEvidenceError, EvidenceTamperedError } from "@/evidence/service";
import { getEvidenceStore } from "@/evidence/store";
```

`actor` is `{ id, ipAddress }` (a `CurrentUser` works).

### Upload (from the browser)

Uploads never pass through the Next.js server (Vercel limits request bodies to 4.5 MB).

1. `beginUpload(db, store, actor, { filename, size })` → `{ uploadId, url, headers }`: a 5-minute presigned URL. The browser `PUT`s the file to `url` with those `headers`. Server actions `beginEvidenceUpload` / `finishEvidenceUpload` (`src/evidence/actions.ts`) wrap both steps and check `evidence.upload`.
2. `finishUpload(db, store, actor, uploadId)` → `{ evidenceId, filename, sha256, sizeBytes, reused }`: the server checks size and type, computes the SHA-256 checksum and files the bytes under `files/<sha256>`. A file whose checksum is already stored is reused (`reused: true`), not stored twice.

### Upload (bytes the server already has)

`storeEvidenceBytes(db, store, actor, filename, bytes)` runs the same checks, checksum and de-duplication, for files such as import spreadsheets.

### Link

```ts
const { link, duplicateExceptionId } = await linkEvidence(tx, actor, {
  evidenceId,
  entityType: "DisbursementVoucher",
  entityId: voucher.id,
  kind: "PRIMARY",                                // or "SUPPORTING"
  submissionKey: `DISBURSEMENT_VOUCHER:${voucher.id}`,
  duplicateReason,                                // only when reusing a primary file
});
```

- **Primary** evidence is what a record is created from; **supporting** evidence is added later (to an exception, a correction, a note).
- A **submission** is one thing someone handed in (a schedule with its rows, a statement, a voucher, an application). Use `<SUBMISSION_TYPE>:<id>` as the key, prefixed with your module's own types.
- **Duplicate evidence flag:** if the file is already primary evidence of a *different* submission, the link needs a reason (at least 5 characters; without it `DuplicateEvidenceError` names the other submissions). With a reason, the link is made and a `DUPLICATE_EVIDENCE` exception is raised for the Finance Manager and the GMD. Reuse within one submission and supporting links are never flagged.
- Linking the same file to the same record twice returns the existing link. Every link is audited (`evidence.link`).

### Retrieve

`openEvidence(db, store, actor, evidenceId)` re-reads the stored bytes and re-checks the checksum, then returns a 5-minute download URL. A mismatch or missing file raises an `EVIDENCE_TAMPERED` exception and throws `EvidenceTamperedError` (status 409): the file can't be opened. Over HTTP: `GET /api/v1/evidence/{id}` (permission `evidence.read`).

---

## 4. Module registration

The registry (`shell.module`) holds every module's code, name, status and the ledger event types it emits.

```ts
import { registerModule, moduleStatus, assertModuleCanPost, ModuleError } from "@/shell/registry/registry";

await registerModule(db, {
  code: "SAVINGS",                 // 2–20 capital letters, digits or _
  name: "Savings",
  eventTypes: ["CASH_IN", "CASH_OUT", "DEPOSIT_CREDITED"],
});
```

- `registerModule` creates the module, or updates its name and event list; it never changes the status. A new module starts `LIVE`.
- **Status** is `LIVE`, `DEGRADED` or `OFFLINE`, changed by the Admin on `/staff/admin/modules` with a reason (audited `module.status_changed`). `DEGRADED` only shows a banner to staff. `OFFLINE` refuses every server action of the module (pages stay readable) and every ledger posting or reversal for it. The Portal Shell (`SHELL`) can't be taken offline.
- **Status endpoint:** `GET /api/v1/modules/{code}/status` (public, for monitoring) returns `{ code, name, status, eventTypes }`.
- **Event types:** `postEvent` refuses an event type the module has not declared. Event types come from the shared `LedgerEventType` list; a module that needs a new one adds it to that list (see the registration guide).
- Exceptions: a module raises its own with `raiseException(db, { moduleCode, type, dedupeKey, title, details, amount })` (`src/shell/exceptions/exceptions.ts`). They go into the portal-wide register, the Finance Manager reviews them and the GMD closes them.

---

## Also available to modules

These are not among the four contracts but every module uses them.

| Service | Code | Use |
|---|---|---|
| Audit trail | `writeAudit(db, { action, entityType, entityId, userId, ipAddress, before, after, evidenceRef })` (`src/shell/audit/audit.ts`) | Every action that changes something. Insert-only. |
| Settings | `getRateSetting` / `getCountSetting` / `getDateSetting` (`src/shell/settings/settings.ts`), definitions in `definitions.ts` | Never hard-code a limit that should be a setting. Financial settings need Management approval. |
| Status messages | `queueForUser` / `queueForMembers` / `queueForRoles` (`src/shell/notifications/messages.ts`) | Queued in your transaction, sent once per key `<trigger>:<entity>`, by SMS or email per the user's channel. Never for codes or links. |
| One-time codes and links | `notify(db, { idempotencyKey, channel, recipient, template, text, sensitive })` (`src/shell/notifications/notify.ts`) | Text is never stored. |
| Scheduled jobs | `JOBS` (`src/jobs/definitions.ts`), runner `src/shell/jobs/runner.ts` | Must be idempotent and batch-friendly. |
| Exceptions | `raiseException`, `refreshException` (`src/shell/exceptions/exceptions.ts`) | Portal-wide register, closed by the GMD. |
