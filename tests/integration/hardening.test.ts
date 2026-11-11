/**
 * Shared rate limit, message retries and the exception-ageing reminder against
 * the test database (PRD §5, F15). Skipped when TEST_DATABASE_URL is not set.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { allowShared } from "@/lib/rate-limit";
import { JOBS } from "@/jobs/definitions";
import { runJob, type JobDefinition } from "@/shell/jobs/runner";
import { retryFailed } from "@/shell/notifications/messages";
import { MAX_ATTEMPTS, notify } from "@/shell/notifications/notify";
import type { NotificationProvider } from "@/shell/notifications/providers";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

describeDb("hardening before F15", () => {
  let db: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const provider = (ok: boolean): NotificationProvider & { sent: string[] } => {
    const sent: string[] = [];
    return { name: "test", sent, send: async (m) => (sent.push(m.text), { ok, response: ok ? "ok" : "down" }) } as NotificationProvider & { sent: string[] };
  };

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
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("counts a rate limit in the database and starts again after the window", async () => {
    const key = `test:${run}`;
    const t0 = 1_900_000_000_000;
    expect(await allowShared(db, key, 2, 60_000, t0)).toBe(true);
    expect(await allowShared(db, key, 2, 60_000, t0 + 1_000)).toBe(true);
    expect(await allowShared(db, key, 2, 60_000, t0 + 2_000)).toBe(false);
    const row = await db.rateLimit.findUniqueOrThrow({ where: { key: `app:${key}` } });
    expect(row.count).toBe(3);
    expect(await allowShared(db, key, 2, 60_000, t0 + 60_000)).toBe(true);
  });

  it("resends a failed status message, and never keeps the text of one that isn't marked retryable", async () => {
    const prefix = `test-retry:${run}:`;
    const base = { channel: "EMAIL" as const, recipient: `retry-${run}@example.invalid`, template: "test.notice", subject: "Notice" };
    await notify(db, { ...base, idempotencyKey: `${prefix}a`, text: "Your loan was approved.", retryable: true }, provider(false));
    await notify(db, { ...base, idempotencyKey: `${prefix}b`, text: "Your code is 123456." }, provider(false));

    const a = await db.notification.findUniqueOrThrow({ where: { idempotencyKey: `${prefix}a` } });
    const b = await db.notification.findUniqueOrThrow({ where: { idempotencyKey: `${prefix}b` } });
    expect(a).toMatchObject({ status: "FAILED", retryText: "Your loan was approved.", attempts: 1 });
    expect(b).toMatchObject({ status: "FAILED", retryText: null });

    const up = provider(true);
    expect(await retryFailed(db, new Date(), up, prefix)).toEqual({ retried: 1, sent: 1, gaveUp: 0 });
    expect(up.sent).toEqual(["Your loan was approved."]);
    expect(await db.notification.findUniqueOrThrow({ where: { idempotencyKey: `${prefix}a` } })).toMatchObject({ status: "SENT", retryText: null, attempts: 2 });
    // Nothing left to send.
    expect((await retryFailed(db, new Date(), up, prefix)).retried).toBe(0);
  });

  it("gives up after the last attempt and clears the text", async () => {
    const prefix = `test-giveup:${run}:`;
    const down = provider(false);
    await notify(db, { idempotencyKey: `${prefix}a`, channel: "SMS", recipient: "+2348000000000", template: "test.notice", text: "Schedule posted.", retryable: true }, down);
    let gaveUp = 0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) gaveUp += (await retryFailed(db, new Date(), down, prefix)).gaveUp;
    expect(gaveUp).toBe(1);
    expect(await db.notification.findUniqueOrThrow({ where: { idempotencyKey: `${prefix}a` } })).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS, retryText: null });
    expect((await retryFailed(db, new Date(), down, prefix)).retried).toBe(0);
  });

  it("counts exceptions open for more than 30 days in the ageing job", async () => {
    const job = JOBS.find((j) => j.name === "exception-ageing") as JobDefinition;
    const before = ((await runJob(db, job, "test")).summary as { overdue: number }).overdue;
    await db.exceptionRecord.create({
      data: { moduleCode: "CREDIT", type: "SHORTFALL", dedupeKey: `test-ageing:${run}`, title: `Test shortfall ${run}`, raisedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    await db.exceptionRecord.create({
      data: { moduleCode: "CREDIT", type: "SHORTFALL", dedupeKey: `test-ageing-new:${run}`, title: `Test recent ${run}`, raisedAt: new Date(Date.now() - 5 * 86_400_000) },
    });
    const after = await runJob(db, job, "test");
    expect(after.status).toBe("SUCCEEDED");
    expect((after.summary as { overdue: number }).overdue).toBe(before + 1);
    expect(JOBS.map((j) => j.name)).toEqual(expect.arrayContaining(["notification-retry", "exception-ageing"]));
  });
});
