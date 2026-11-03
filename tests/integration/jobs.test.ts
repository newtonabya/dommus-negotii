/**
 * Scheduled job runner and the 1a jobs against the test database (PRD §5).
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { JOBS } from "@/jobs/definitions";
import { runJob, type JobDefinition } from "@/shell/jobs/runner";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

describeDb("scheduled jobs", () => {
  let db: PrismaClient;
  let dir: string;
  const run = randomUUID().slice(0, 8);
  const job = (name: string, body: JobDefinition["run"]): JobDefinition => ({ name: `test-${name}-${run}`, label: name, description: "test", run: body });
  const real = (name: string) => JOBS.find((j) => j.name === name) as JobDefinition;

  beforeAll(async () => {
    db = createClient(url as string);
    for (let attempt = 1; ; attempt++) {
      try {
        await db.$queryRaw`SELECT 1`;
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    // The evidence cleanup job uses the configured store: point it at a temp folder.
    dir = await mkdtemp(path.join(tmpdir(), "jobs-"));
    process.env.EVIDENCE_STORE = "local";
    process.env.EVIDENCE_LOCAL_DIR = dir;
    process.env.BETTER_AUTH_SECRET ??= "test-secret-for-local-store";
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("logs a successful run with its summary, and a failed run with its error", async () => {
    const ok = await runJob(db, job("ok", async () => ({ done: 3 })), "test");
    expect(ok).toMatchObject({ status: "SUCCEEDED", summary: { done: 3 }, trigger: "test" });
    expect(ok.finishedAt).not.toBeNull();

    const failed = await runJob(db, job("fail", async () => { throw new Error("Bank feed unreachable"); }), "test");
    expect(failed).toMatchObject({ status: "FAILED", error: "Bank feed unreachable" });
  });

  it("never runs a job twice at once, and gives up on a run that died", async () => {
    const slow = job("overlap", async () => ({ ran: true }));
    const running = await db.jobRun.create({ data: { job: slow.name, trigger: "test" } });
    expect((await runJob(db, slow, "test")).id).toBe(running.id);

    // The same run, 20 minutes later, is treated as dead and a new run goes ahead.
    const later = new Date(Date.now() + 20 * 60_000);
    const next = await runJob(db, slow, "test", later);
    expect(next.id).not.toBe(running.id);
    expect(next.status).toBe("SUCCEEDED");
    expect((await db.jobRun.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("FAILED");
  });

  it("clears expired one-time codes but keeps live ones", async () => {
    const expired = await db.verification.create({
      data: { id: randomUUID(), identifier: `test-job:${run}`, value: "x", expiresAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    const live = await db.verification.create({
      data: { id: randomUUID(), identifier: `test-job:${run}`, value: "y", expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const result = await runJob(db, real("auth-housekeeping"), "test");
    expect(result.status).toBe("SUCCEEDED");
    expect(await db.verification.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await db.verification.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it("measures the database and cleans abandoned uploads", async () => {
    const usage = await runJob(db, real("database-usage"), "test");
    expect(usage.status).toBe("SUCCEEDED");
    expect(BigInt((usage.summary as { bytes: string }).bytes)).toBeGreaterThan(0n);

    const cleanup = await runJob(db, real("evidence-staging-cleanup"), "test");
    expect(cleanup.status).toBe("SUCCEEDED");
    expect(cleanup.summary).toHaveProperty("abandonedUploads");
  });
});
