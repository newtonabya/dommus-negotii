import { getEvidenceStore } from "@/evidence/store";
import { alertAdmins, alertRoles, type JobDefinition } from "@/shell/jobs/runner";
import { retryFailed } from "@/shell/notifications/notify";

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

/** Sends failed status messages again, and tells the Admins when a provider keeps failing (PRD F15). */
const notificationRetry: JobDefinition = {
  name: "notification-retry",
  label: "Resend failed messages",
  description: "Sends failed SMS and emails again (up to 4 attempts over 3 days; never codes or links) and emails the Admins when messages are given up on.",
  async run({ db, now }) {
    const result = await retryFailed(db, now);
    let alerted = 0;
    if (result.gaveUp > 0) {
      alerted = await alertAdmins(
        db,
        `notification-failures:${now.toISOString().slice(0, 10)}`,
        "Messages could not be delivered",
        `${result.gaveUp} message(s) failed on every attempt and were given up on. Check the SMS and email providers (balance, sender ID, API keys).`,
      );
    }
    return { ...result, alerted };
  },
};

/** Exceptions still open this many days after they were raised are chased (PRD F15). */
export const EXCEPTION_AGEING_DAYS = 30;

/** Reminds the Finance Manager and the GMD, once a week, of exceptions open for over 30 days. */
const exceptionAgeing: JobDefinition = {
  name: "exception-ageing",
  label: "Chase old exceptions",
  description: "Emails the Finance Manager and the GMD once a week while any exception has been open for more than 30 days.",
  async run({ db, now }) {
    const old = await db.exceptionRecord.findMany({
      where: { status: { not: "CLOSED" }, raisedAt: { lt: new Date(now.getTime() - EXCEPTION_AGEING_DAYS * DAY) } },
      orderBy: { raisedAt: "asc" },
      select: { title: true, status: true, raisedAt: true },
    });
    if (old.length === 0) return { overdue: 0, alerted: 0 };
    // One reminder a week: the key is the Monday of the current week.
    const monday = new Date(now.getTime() - ((now.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    const lines = old
      .slice(0, 20)
      .map((e) => `- ${e.title} (${e.status === "OPEN" ? "not yet reviewed" : "under review"}, ${Math.floor((now.getTime() - e.raisedAt.getTime()) / DAY)} days)`);
    const more = old.length > 20 ? `\n… and ${old.length - 20} more` : "";
    const alerted = await alertRoles(
      db,
      ["FINANCE_MANAGER", "GMD"],
      `exception-ageing:${monday}`,
      `${old.length} exception(s) open for more than ${EXCEPTION_AGEING_DAYS} days`,
      `These exceptions have been open for more than ${EXCEPTION_AGEING_DAYS} days:\n\n${lines.join("\n")}${more}\n\nSee Exceptions in Dommus Negotii. The Finance Manager reviews; the GMD closes.`,
    );
    return { overdue: old.length, alerted };
  },
};

/** The batch run by Vercel Cron, in order. */
export const JOBS: readonly JobDefinition[] = [authHousekeeping, evidenceStagingCleanup, databaseUsage, notificationRetry, exceptionAgeing];
