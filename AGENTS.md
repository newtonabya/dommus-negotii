<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Database (Neon)

- Staging project `dommus-negotii-staging` (`rough-voice-82311957`), linked in `.neon`. Branches: `main` (staging data), `dev` (local `next dev`, via `.env.development.local`) and `test` (throwaway, for `tests/integration`, used by local runs and CI). Production is a separate project, created later.
- `.env.local` holds four URLs: `DIRECT_URL` (owner, migrations), `DATABASE_URL` (app_runtime, pooled — the app), and the same pair as `TEST_DIRECT_URL` / `TEST_DATABASE_URL` for the `test` branch. CI gets the test pair from the GitHub repository secrets of the same names.
- **Never run `neon env pull`, or `neon link` / `neon checkout` without `--no-env-pull`.** They write the owner role into `DATABASE_URL`, which would bypass the app_runtime grants (PRD §5).
- Migrations: `npx prisma migrate deploy` (uses `DIRECT_URL`). After creating a new branch, run `node scripts/set-runtime-password.mjs .env.local <VAR> <OWNER_VAR>` to give it an app_runtime URL.
- Prisma does not wrap a migration in a transaction, so **write every new migration.sql between `BEGIN;` and `COMMIT;`**: a dropped connection then leaves nothing half-applied. For the older, unwrapped migrations, a P3009 after a drop means: check which statements took effect (tables, indexes, constraints), apply only the missing ones, then `npx prisma migrate resolve --applied <name>`. Never re-run the whole file.
- Interactive transactions pass `TX_OPTIONS` (`src/lib/db.ts`); Prisma's 5-second default is too short over Neon from here. Bulk imports use their own longer limit.
- Ledger, audit, evidence and settings rows are append-only, even for the owner. Test rows can't be cleaned up, so reset the `test` branch from `main` instead.
- Local test logins (Admin, Cashier, both with TOTP) live on the `dev` branch; their credentials are in `.env.development.local`.
- Skills: `neon`, `neon-postgres` (`.claude/skills`, pinned in `skills-lock.json`). Check them with `neon skills status`.

## Staging

- Vercel project `dommus-negotii-staging` deploys `main` to https://dommus-negotii-staging.vercel.app (Neon `main` branch). See README "Staging".
- Migrations are never run by the build: run `npx prisma migrate deploy` against Neon `main` before pushing a schema change.
- Staging evidence lives in Neon Object Storage (bucket `dommus-evidence`, branch `main`). The S3 client turns off the SDK's automatic checksums: with them, presigned PUT URLs carry a checksum of an empty body and browser uploads fail.
- `APP_STAGE=staging` (`src/lib/stage.ts`) makes every SMS and email go to the log, even with provider keys set. Never set it in production.

## Settings (PRD F2)

- `src/shell/settings/`: `definitions.ts` lists every setting (financial or operational, kind, PRD default, range); `settings.ts` reads values and handles changes. Read a value with `getRateSetting` / `getCountSetting` / `getDateSetting` (as of a Lagos date); never hard-code a limit that is a setting.
- The value in force on a date is the `shell.setting` row with the latest `effective_from` on or before it (latest `created_at` wins on the same date), else the PRD default. Rows are append-only. Proposals never count until approved (AT-r).
- Financial settings: Admin proposes (value, effective date not in the past, reason); Management approves or rejects; the proposer may withdraw. Nobody approves their own proposal, a proposal whose date has passed can't be approved, and only one proposal per setting may be open (partial unique index `setting_change_request_one_pending`, Prisma preview feature `partialIndexes`).
- The service functions take `today` as a parameter: tests use random dates centuries ahead because test rows can't be deleted.

## Audit trail (PRD F2)

- Write with `writeAudit` (`src/shell/audit/audit.ts`); the table is insert-only for every role. Search and Excel export live in `src/shell/audit/search.ts`: filters by user (name, email or id), Lagos date range, action, record type and id; 50 per page; exports hold at most 20,000 rows and are themselves audited (`audit.exported`).
- Only the Auditor has `audit.read` (page `/staff/audit`, export `/api/v1/audit/export?<same filters>`).

## Module registry (PRD F2, §8 contract 4)

- `src/shell/registry/registry.ts` (not `src/shell/modules/`: that path trips the "shared layers never import modules" lint rule). A module registers with `registerModule(db, { code, name, eventTypes })`; `CREDIT` was registered by the auth migration.
- `postEvent` refuses events from unregistered modules or undeclared event types, and `postEvent`/`reverseEvent` refuse while the module is OFFLINE. `authorizeAction` refuses every action of an OFFLINE module (pages stay readable); DEGRADED only shows a banner. SHELL can't be taken offline.
- Admin page `/staff/admin/modules` (status changes need a reason and are audited); public status endpoint `/api/v1/modules/<code>/status`.
- Integration tests that change a status register their own throwaway module, never CREDIT.

## Jobs, monitoring, backups (PRD §5)

- Scheduled jobs: definitions in `src/jobs/definitions.ts` (`JOBS`), runner in `src/shell/jobs/runner.ts` (logs every run in `shell.job_run`, skips a job already running, marks runs older than 15 minutes as dead, emails Admins on failure). Vercel Cron calls `/api/v1/jobs/run` twice a day (vercel.json) with `Authorization: Bearer $CRON_SECRET`; without `CRON_SECRET` nothing runs. Admin page `/staff/admin/jobs` has "Run now". Jobs must be idempotent and batch-friendly (Neon Free: the database should sleep between batches).
- `/api/v1/health` never touches the database (uptime monitors must not wake Neon). `src/instrumentation.ts` logs server errors as scrubbed JSON lines (`src/lib/scrub.ts`); search Vercel logs for `server-error`.
- Backups: `.github/workflows/backup.yml` nightly (02:30 Lagos) dumps with the read-only `backup_reader` role, checks the table of contents, encrypts with the age public key (secret `BACKUP_AGE_RECIPIENT`), uploads to bucket `dommus-backups` on the Neon branch `backups` (daily 35 days, month-end 7 years) and keeps a 35-day workflow artifact. Secrets: `BACKUP_DATABASE_URL`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_AGE_RECIPIENT`. Restore: `docs/RESTORE.md` and `scripts/decrypt-backup.mjs`. The private key is never in the repo or on GitHub.

## Loan engine (PRD F6)

- Pure, no I/O: `src/modules/credit/domain/schedule.ts` (planned schedule, indicative calculator), `allocation.ts` (allocation helpers, `diffAllocations` for recompute), `recompute.ts` (`computeLoanState`, `payoffQuote`). Money is bigint kobo, rates bps; the lint rule and `tests/unit/no-float-money.test.ts` forbid floats there.
- `computeLoanState(terms, payments, asOf)` replays payments by payment date, then posting order. Each cycle is done in two passes: first the principal arrears the cycle's payments clear (fixes the interest base Bk, the grace window), then the allocation (arrears oldest first, interest before principal → cycle interest → cycle principal → prepayment re-spread → Overpayment Credit after closure).
- `payoffQuote` simulates a pay-everything payment, so the quote always equals what closes the loan.
- `tests/unit/loan-engine.test.ts` holds PRD cases A–I and AT-a/o/s/m; keep them passing exactly.
- Not yet: legacy opening balances (F8) start the computation from the go-live date.

## Evidence (PRD F3)

- `src/evidence/`: upload in two steps (`beginUpload` → browser PUTs to a 5-minute URL under `staging/` → `finishUpload` checks size and real type from the bytes, hashes server-side, files under `files/<sha256>`); `linkEvidence` attaches a file to a record; `openEvidence` re-hashes before issuing a 5-minute download URL.
- Uploads never pass through the Next.js server (Vercel's 4.5 MB body limit); the server only downloads to verify.
- `files/` is write-once and never deleted (production: R2 bucket lock, 7 years). Only `staging/` objects are removed. There is no delete endpoint.
- A file reused as PRIMARY evidence for a different submission needs a reason and opens a `DUPLICATE_EVIDENCE` exception; a failed integrity check opens `EVIDENCE_TAMPERED`.
- Exceptions live in the portal-wide `shell.exception` register (`src/shell/exceptions/`), not a credit-only table, so any module can raise them and the GMD closes them in one place.
- Development uses the local store (`EVIDENCE_STORE=local`, files in `.evidence-store/`, served by the dev-only `/api/dev/evidence-store` route).

## Members (PRD F5)

- `src/modules/credit/members/`: `invitations.ts` (send, resend, revoke; 50 per sender per day, 3 per phone per week, counted from the audit trail), `registration.ts` (the `/join/<token>` flow), `review.ts` (Loan Officer activate/decline), `sources.ts` (remittance sources), `rules.ts` (form schemas, consent text and version).
- Invitation links: 32 random bytes, only the SHA-256 is stored, 7-day expiry, single use; resending replaces the token. Registration must verify the invited phone with an SMS code (`auth.api.consumePhoneNumberOTP`) and creates the login, password account and PENDING member in one transaction.
- Before registration the registrant has no login, so their ID-scan upload uses the uploader id `invitation:<id>` and is only accepted for that invitation.
- Members without an email get a `…@members.dommus.invalid` login email (the user table requires one).
- Better Auth's public `/phone-number/send-otp` only texts numbers with a login or an open invitation (SMS costs money); it answers the same either way.
- The open registration link (`open_registration_enabled`) is not built: registration is by invitation only.
- Profile changes (`profile-changes.ts`, member page `/member/profile`, Loan Officer page `/staff/members/profile-changes`): only changed fields are stored, with `before` values; one open request per member (partial unique index); a new phone is proven with an SMS code first (`phone-change.ts`, hashed in Better Auth's `verification` table, 10 minutes, 5 tries); a new name or MOAUM ID needs a supporting document. Approval updates member and login (name, phone, placeholder email) in one transaction; nobody decides their own.
- NDPA data copy: `/api/v1/me/data-copy?format=pdf|json` (`data-copy.ts`), any member-record owner, every download audited. The PDF uses standard fonts, which drop accents; the JSON keeps exact text.
- Lists (`src/modules/credit/imports/`): CSV (UTF-8) or XLSX (first sheet), at most 2 MB and 2,000 rows, headers normalised (`Full Name` → `full_name`); templates at `/api/v1/templates/(invitations|members).(xlsx|csv)`. Every upload is a dry run first: an `ImportBatch` (PREVIEWED) plus an `ImportRowLog` per row with its errors; only the uploader can commit it, once. Phones may lack the leading zero (Excel drops it).
- Bulk invitations (`bulk-invitations.ts`) send the valid rows and skip the rest, within the daily quota. The Admin member import (`member-import.ts`) is all or nothing: it re-validates on commit, and any error rejects the whole batch. It stores the file as evidence, creates ACTIVE members (they are already members) with a login that has no password yet, and texts each an ACTIVATION invitation.
- An ACTIVATION link opens the same `/join/<token>` page, which then asks only for consent, a password, the SMS code and, if missing, the ID scan (`activateImportedMember`). REGISTRATION and ACTIVATION links can't be used for each other's flow.

## Auth

- Better Auth 1.7 (`src/shell/auth/auth.ts`): staff sign in with email, members with phone or email; TOTP is mandatory for every staff role. Public sign-up is off: the first Admin comes from `/setup` (needs `SETUP_TOKEN`), staff are created by an Admin and set their own password through an emailed link.
- Every staff page uses `requireStaff()` / `requireStaffPermission()`, every server action `authorizeAction(action)` (`src/shell/auth/session.ts`). These read the session without refreshing it, so `session.updatedAt` is the last real activity; only `<SessionActivity />` refreshes it on user input.
- Never call `auth.$context.internalAdapter` from server actions: it only works inside a Better Auth request. Write auth tables with Prisma in a transaction (see `src/app/setup/actions.ts`).
- `cacheComponents` is off on purpose (`next.config.ts`).
