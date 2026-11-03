/**
 * Module registry against the test database (PRD F2 DoD, §8 contract 4).
 * Status changes use a throwaway module per run so CREDIT is never taken
 * offline under other tests. Skipped when TEST_DATABASE_URL is not set.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { EVENT_TYPES, RESERVED_EVENT_TYPES } from "@/ledger/events";
import { postEvent, reverseEvent } from "@/ledger/post";
import { listModules, ModuleError, registerModule, setModuleStatus } from "@/shell/registry/registry";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

describeDb("module registry", () => {
  let db: PrismaClient;
  const run = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const code = `TST_${run}`;
  const admin = { id: `admin-${run}`, ipAddress: "127.0.0.1" };
  const evidenceId = randomUUID();

  const event = (key: string, eventType: "CASH_IN" | "CASH_OUT" = "CASH_IN") => ({
    occurredAt: new Date("2026-04-01"),
    moduleCode: code,
    eventType,
    source: "REMITTANCE_SCHEDULE" as const,
    evidenceRefs: [evidenceId],
    portalUserId: "test",
    moduleEntityType: "TestThing",
    moduleEntityId: `thing-${run}`,
    cashAmount: 5_000n,
    uniquenessKey: `${run}:${key}`,
  });

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
    await db.evidenceFile.create({
      data: {
        id: evidenceId,
        filename: "slip.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        storageKey: `test/${run}`,
        uploadedById: "test",
      },
    });
    await registerModule(db, { code, name: `Test module ${run}`, eventTypes: ["CASH_IN"] });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("registers CREDIT with every Phase 1 ledger event type (F2 DoD)", async () => {
    const credit = await db.module.findUniqueOrThrow({ where: { code: "CREDIT" } });
    const expected = EVENT_TYPES.filter((t) => !RESERVED_EVENT_TYPES.includes(t));
    expect([...credit.eventTypes].sort()).toEqual([...expected].sort());
    const { modules } = await listModules(db);
    expect(modules.find((m) => m.code === "CREDIT")?.events.map((e) => e.type).sort()).toEqual([...expected].sort());
  });

  it("refuses ledger events from unregistered modules and undeclared event types", async () => {
    await expect(postEvent(db, { ...event("unknown"), moduleCode: `NOPE_${run}` })).rejects.toThrow(/not registered/);
    await expect(postEvent(db, event("undeclared", "CASH_OUT"))).rejects.toThrow(/has not registered the event type CASH_OUT/);
    await expect(postEvent(db, event("ok"))).resolves.toMatchObject({ created: true });
  });

  it("stops postings and reversals while a module is OFFLINE, with an audited reason", async () => {
    const { event: posted } = await postEvent(db, event("before-offline"));
    await expect(setModuleStatus(db, admin, code, "OFFLINE", "no")).rejects.toThrow(/reason/);
    await setModuleStatus(db, admin, code, "OFFLINE", "Maintenance window");
    await expect(postEvent(db, event("while-offline"))).rejects.toThrow(ModuleError);
    const reversal = { uniquenessKey: `${run}:rev`, occurredAt: new Date("2026-04-02"), portalUserId: "test", evidenceRefs: [evidenceId], reason: "test" };
    await expect(reverseEvent(db, posted.id, reversal)).rejects.toThrow(/offline/);

    await setModuleStatus(db, admin, code, "DEGRADED", "Slow bank feed today");
    await expect(postEvent(db, event("while-degraded"))).resolves.toMatchObject({ created: true });
    await expect(setModuleStatus(db, admin, code, "DEGRADED", "again please")).rejects.toThrow(/already degraded/);
    await setModuleStatus(db, admin, code, "LIVE", "Back to normal");

    const audit = await db.auditLog.findMany({ where: { action: "module.status_changed", entityId: code }, orderBy: { occurredAt: "asc" } });
    expect(audit.map((a) => (a.after as { status: string }).status)).toEqual(["OFFLINE", "DEGRADED", "LIVE"]);
    await expect(setModuleStatus(db, admin, "SHELL", "OFFLINE", "should not work")).rejects.toThrow(/Portal Shell/);
  });
});
