import { getEvidenceStore } from "@/evidence/store";
import { alertAdmins, type JobDefinition } from "@/shell/jobs/runner";

/** Neon Free plan storage per project (PRD §5 guardrails). */
export const FREE_DATABASE_BYTES = 512n * 1024n * 1024n;
const DAY = 86_400_000;

/** Removes expired login sessions and one-time codes (Better Auth keeps them otherwise). */
const authHousekeeping: JobDefinition = {
  name: "auth-housekeeping",
  label: "Clear expired sessions and codes",
  description: "Deletes login sessions and one-time codes (SMS, reset links) that expired more than a day ago.",
  async run({ db, now }) {
    const cutoff = new Date(now.getTime() - DAY);
    const sessions = await db.session.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    const codes = await db.verification.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    return { deletedSessions: sessions.count, deletedCodes: codes.count };
  },
};

/**
 * Deletes the temporary copies of uploads that were started but never finished
 * (PRD F3: only `staging/` objects are ever removed). Looks at uploads 1–3 days
 * old, so every one is retried by several runs; deleting twice is harmless.
 */
const evidenceStagingCleanup: JobDefinition = {
  name: "evidence-staging-cleanup",
  label: "Remove abandoned uploads",
  description: "Removes the temporary copy of evidence uploads started 1–3 days ago and never finished. Stored evidence is never touched.",
  async run({ db, now }) {
    const abandoned = await db.evidenceUpload.findMany({
      where: { finishedAt: null, createdAt: { gte: new Date(now.getTime() - 3 * DAY), lt: new Date(now.getTime() - DAY) } },
      select: { stagingKey: true },
    });
    const store = getEvidenceStore();
    let removed = 0;
    for (const upload of abandoned) {
      await store.deleteStaging(upload.stagingKey);
      removed++;
    }
    return { abandonedUploads: abandoned.length, removed };
  },
};

/** Warns the Admins before the database outgrows the Neon Free plan. */
const databaseUsage: JobDefinition = {
  name: "database-usage",
  label: "Check database size",
  description: "Measures the database against the Neon Free plan's 0.5 GB and emails the Admins at 80%.",
  async run({ db, now }) {
    const [row] = await db.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database())::bigint AS bytes`;
    const bytes = row?.bytes ?? 0n;
    const percent = Number((bytes * 100n) / FREE_DATABASE_BYTES);
    let alerted = 0;
    if (percent >= 80) {
      const month = now.toISOString().slice(0, 7);
      alerted = await alertAdmins(
        db,
        `database-usage-80:${month}`,
        "Database at 80% of the Neon Free plan",
        `The database uses ${(Number(bytes) / 1048576).toFixed(0)} MB, ${percent}% of the Free plan's 512 MB. Upgrade the Neon plan before it fills up.`,
      );
    }
    return { bytes: bytes.toString(), percentOfFree: percent, alerted };
  },
};

/** The batch run by Vercel Cron, in order. */
export const JOBS: readonly JobDefinition[] = [authHousekeeping, evidenceStagingCleanup, databaseUsage];
