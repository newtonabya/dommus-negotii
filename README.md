# Dommus Negotii

MOAUM's group services portal. Phase 1: Portal Shell, Shared Ledger, Evidence
Repository and the Credit Super Store cooperative loan module. The full
requirements are in [PRD.md](PRD.md); agent and developer notes are in
[AGENTS.md](AGENTS.md).

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Prisma 7 on Neon Postgres ·
Better Auth (email/phone + TOTP) · Tailwind CSS · Jest · Vercel.

## Getting started

Requires Node.js 24 (see `.nvmrc`).

```bash
npm ci
```

Create `.env.local` from `.env.example` and fill in the Neon connection strings
and a `BETTER_AUTH_SECRET`. For local development, `.env.development.local`
points `DATABASE_URL` at the Neon `dev` branch.

```bash
npx prisma migrate deploy   # apply migrations (uses DIRECT_URL)
npm run dev                 # http://localhost:3000
```

On a fresh database, open `/setup` with the `SETUP_TOKEN` to create the first
Admin, then sign in and set up two-factor login.

## Checks

```bash
npm run lint
npx next typegen && npx tsc --noEmit
npm test
```

Database tests in `tests/integration` run only when `TEST_DATABASE_URL` and
`TEST_DIRECT_URL` point at a throwaway Neon branch; they are skipped otherwise.
