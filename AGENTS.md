<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Database (Neon)

- Staging project `dommus-negotii-staging` (`rough-voice-82311957`), linked in `.neon`. Branches: `main` (staging data), `dev` (local `next dev`, via `.env.development.local`) and `test` (throwaway, for `tests/integration`). Production is a separate project, created later.
- Local test logins (Admin, Cashier, both with TOTP) live on the `dev` branch; their credentials are in `.env.development.local`.

## Auth

- Better Auth 1.7 (`src/shell/auth/auth.ts`): staff sign in with email, members with phone or email; TOTP is mandatory for every staff role. Public sign-up is off: the first Admin comes from `/setup` (needs `SETUP_TOKEN`), staff are created by an Admin and set their own password through an emailed link.
- Every staff page uses `requireStaff()` / `requireStaffPermission()`, every server action `authorizeAction(action)` (`src/shell/auth/session.ts`). These read the session without refreshing it, so `session.updatedAt` is the last real activity; only `<SessionActivity />` refreshes it on user input.
- Never call `auth.$context.internalAdapter` from server actions: it only works inside a Better Auth request. Write auth tables with Prisma in a transaction (see `src/app/setup/actions.ts`).
- `cacheComponents` is off on purpose (`next.config.ts`).
- `.env.local` holds four URLs: `DIRECT_URL` (owner, migrations), `DATABASE_URL` (app_runtime, pooled — the app), and the same pair as `TEST_DIRECT_URL` / `TEST_DATABASE_URL` for the `test` branch.
- **Never run `neon env pull`, or `neon link` / `neon checkout` without `--no-env-pull`.** They write the owner role into `DATABASE_URL`, which would bypass the app_runtime grants (PRD §5).
- Migrations: `npx prisma migrate deploy` (uses `DIRECT_URL`). After creating a new branch, run `node scripts/set-runtime-password.mjs .env.local <VAR> <OWNER_VAR>` to give it an app_runtime URL.
- Ledger, audit, evidence and settings rows are append-only, even for the owner. Test rows can't be cleaned up, so reset the `test` branch from `main` instead.
- Skills: `neon`, `neon-postgres` (`.claude/skills`, pinned in `skills-lock.json`). Check them with `neon skills status`.
