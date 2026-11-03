# Restoring a backup

The `Backup` GitHub Actions workflow (`.github/workflows/backup.yml`) runs every night at 02:30 Lagos time.
It dumps the database with the read-only `backup_reader` role, checks the dump's table of contents, encrypts it
with the backup **public** key (age) and stores it:

| Copy | Where | Kept |
|---|---|---|
| Daily | bucket `dommus-backups` (Neon project `rough-voice-82311957`, branch `backups`), `daily/YYYY-MM-DD.dump.age` | 35 days |
| Month-end | same bucket, `monthly/YYYY-MM.dump.age` | 7 years |
| Second copy | the workflow run's artifact `backup-YYYY-MM-DD` on GitHub | 35 days |

Each file has a `.sha256` next to it. Targets while on the Neon Free plan: recovery point ≤ 24 hours,
recovery time ≤ 8 hours (PRD §5).

**Only the private key can open a backup.** It is the `AGE-SECRET-KEY-1…` line kept by MOAUM's IT lead in the
password manager (and an offline copy). GitHub and Neon only ever see the public key. If the private key is
lost, every backup is unreadable: keep two copies.

## 1. Get the file

Either download the artifact from the workflow run (Actions → Backup → the run → Artifacts), or copy it from
the bucket with any S3 client, using the `dommus-backup-writer` credential (path-style addressing, region
`eu-central-1`, endpoint `https://br-floral-fog-baf8h7y6.storage.c-8.eu-central-1.aws.neon.tech`):

```bash
aws --endpoint-url "$ENDPOINT" s3 cp s3://dommus-backups/daily/2026-11-04.dump.age .
aws --endpoint-url "$ENDPOINT" s3 cp s3://dommus-backups/daily/2026-11-04.dump.age.sha256 .
```

## 2. Decrypt it

From the project folder, with the private key in `backup-private-key.txt` (or give its path as the third
argument). The script checks the `.sha256` when it is next to the file:

```bash
node scripts/decrypt-backup.mjs 2026-11-04.dump.age 2026-11-04.dump
```

The `age` command-line tool works too: `age --decrypt -i key.txt -o 2026-11-04.dump 2026-11-04.dump.age`.

## 3. Restore into a new branch, never over the live one

1. In the Neon Console, create a branch from `main` named `restore-YYYYMMDD` (with a compute), and copy its
   **owner** (`dommus_owner`) connection string, direct (not pooled).
2. Restore with a PostgreSQL 17 client. Docker is the easiest way to get one:

   ```bash
   docker run --rm -e TARGET -v "$PWD:/work" postgres:17 \
     sh -c 'pg_restore --clean --if-exists --no-owner --exit-on-error --dbname "$TARGET" /work/2026-11-04.dump'
   ```

   `--clean` drops and recreates every object from the dump, including the append-only triggers and the
   `app_runtime` grants, so the restored copy has the same protections.
3. Check it: row counts of `shell.audit_log`, `ledger.ledger_event`, `credit.member` and `evidence.evidence_file`
   should match the day of the backup, and `npx prisma migrate status` against the branch should report it up to date.
4. To switch over, either promote the branch to default in Neon, or point `DATABASE_URL` (app_runtime, pooled)
   in Vercel at it, set a new `app_runtime` password with `scripts/set-runtime-password.mjs`, and redeploy.
5. Evidence files are not in the database dump: they stay in their own bucket, which is write-once.

## Quarterly restore test

Every quarter, restore the latest daily backup into a throwaway branch (steps 1–3), compare the row counts,
delete the branch, and add a line below.

| Date | Backup restored | Result | By |
|---|---|---|---|
| | | | |
