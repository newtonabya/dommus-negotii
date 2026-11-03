import type { JobRun, Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { notify } from "@/shell/notifications/notify";

/**
 * Scheduled jobs (PRD §5): Vercel Cron calls one batch at most twice a day
 * (Neon Free guardrail). Every job is idempotent, every run is logged in
 * shell.job_run, and a failed run emails the Admins.
 */
export interface JobContext {
  db: PrismaClient;
  now: Date;
}

export interface JobDefinition {
  name: string;
  label: string;
  description: string;
  run(ctx: JobContext): Promise<Record<string, Prisma.InputJsonValue | null>>;
}

/** A RUNNING row older than this is a run that died (e.g. a function timeout). */
const STALE_AFTER_MS = 15 * 60_000;

/** Emails every active Admin once per key. Used for failed jobs and usage warnings. */
export async function alertAdmins(db: Db, key: string, subject: string, text: string): Promise<number> {
  const admins = await db.userModuleRole.findMany({
    where: { role: "ADMIN", revokedAt: null, user: { deactivatedAt: null } },
    select: { user: { select: { id: true, email: true } } },
  });
  let sent = 0;
  for (const { user } of admins) {
    const ok = await notify(db, {
      idempotencyKey: `${key}:${user.id}`,
      channel: "EMAIL",
      recipient: user.email,
      template: "admin.alert",
      subject,
      text,
      payload: { key },
    }).catch(() => false);
    if (ok) sent++;
  }
  return sent;
}

/** Runs one job and records the run. Skips it if another run of the same job is still going. */
export async function runJob(db: PrismaClient, job: JobDefinition, trigger: string, now = new Date()): Promise<JobRun> {
  await db.jobRun.updateMany({
    where: { job: job.name, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
    data: { status: "FAILED", finishedAt: now, error: "The run did not finish (timed out or crashed)." },
  });
  const running = await db.jobRun.findFirst({ where: { job: job.name, status: "RUNNING" } });
  if (running) return running;

  const run = await db.jobRun.create({ data: { job: job.name, trigger, startedAt: now } });
  try {
    const summary = await job.run({ db, now });
    return await db.jobRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), summary } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : String(error);
    console.error(`[job ${job.name}]`, error);
    const failed = await db.jobRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: message } });
    await alertAdmins(
      db,
      `job.failed:${run.id}`,
      `Scheduled job failed: ${job.label}`,
      `The scheduled job "${job.label}" failed at ${new Date().toISOString()}:\n\n${message}\n\nSee Admin → Jobs in Dommus Negotii.`,
    ).catch(() => 0);
    return failed;
  }
}

/** Runs every job in order (one batch); a failing job doesn't stop the others. */
export async function runAllJobs(db: PrismaClient, jobs: readonly JobDefinition[], trigger: string): Promise<JobRun[]> {
  const runs: JobRun[] = [];
  for (const job of jobs) runs.push(await runJob(db, job, trigger));
  return runs;
}

/** The latest runs, newest first, for the Admin page. */
export async function recentRuns(db: Db, take = 40) {
  return db.jobRun.findMany({ orderBy: { startedAt: "desc" }, take });
}
