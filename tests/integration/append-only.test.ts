/**
 * Database-level guarantees (PRD F2, F4 DoD). Runs against a migrated,
 * throwaway test database: TEST_DATABASE_URL as app_runtime, TEST_DIRECT_URL as
 * the owner (the Neon `test` branch locally; a temporary branch in CI).
 * Skipped when TEST_DATABASE_URL is not set. Rows written here can never be
 * deleted, so never point these at staging or production.
 */
import { createClient } from "@/lib/db";
import { postEvent, reverseEvent } from "@/ledger/post";
import type { PrismaClient } from "@/generated/prisma/client";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

// Remote database: allow for cold starts (scale-to-zero) and network latency.
jest.setTimeout(30_000);

describeDb("append-only database rules", () => {
  let db: PrismaClient;
  const evidenceId = crypto.randomUUID();
  const run = crypto.randomUUID();

  beforeAll(async () => {
    db = createClient(url as string);
    // Wake a scaled-to-zero compute before the real work.
    for (let attempt = 1; ; attempt++) {
      try {
        await db.$queryRaw`SELECT 1`;
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
    await db.evidenceFile.create({
      data: {
        id: evidenceId,
        filename: "slip.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: run.replaceAll("-", "").padEnd(64, "0"),
        storageKey: `test/${run}`,
        uploadedById: "test",
      },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const event = (key: string) => ({
    occurredAt: new Date("2026-04-01"),
    moduleCode: "CREDIT",
    eventType: "PRINCIPAL_RECOVERY" as const,
    source: "REMITTANCE_SCHEDULE" as const,
    evidenceRefs: [evidenceId],
    portalUserId: "test",
    moduleEntityType: "Loan",
    moduleEntityId: `loan-${run}`,
    principalAmount: 1_000_000n,
    uniquenessKey: `${run}:${key}`,
  });

  it("posts the same uniqueness key once", async () => {
    const first = await postEvent(db, event("dup"));
    const second = await postEvent(db, event("dup"));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
  });

  // Two layers: the app role has no UPDATE/DELETE grant, and a trigger blocks
  // both even for the owner (TEST_DIRECT_URL, when given).
  const owner = process.env.TEST_DIRECT_URL;
  const itOwner = owner ? it : it.skip;

  it("denies the app role UPDATE and DELETE on ledger_event", async () => {
    const { event: e } = await postEvent(db, event("immutable"));
    await expect(
      db.$executeRaw`UPDATE "ledger"."ledger_event" SET "status" = 'X' WHERE "event_id" = ${e.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.$executeRaw`DELETE FROM "ledger"."ledger_event" WHERE "event_id" = ${e.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
  });

  it("denies the app role UPDATE and DELETE on audit_log", async () => {
    const row = await db.auditLog.create({ data: { action: "test", entityType: "Test" } });
    await expect(
      db.$executeRaw`UPDATE "shell"."audit_log" SET "action" = 'x' WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.$executeRaw`DELETE FROM "shell"."audit_log" WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
  });

  itOwner("blocks even the owner from changing ledger and audit rows", async () => {
    const ownerDb = createClient(owner as string);
    try {
      const { event: e } = await postEvent(db, event("owner-immutable"));
      const row = await db.auditLog.create({ data: { action: "test", entityType: "Test" } });
      await expect(
        ownerDb.$executeRaw`UPDATE "ledger"."ledger_event" SET "status" = 'X' WHERE "event_id" = ${e.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        ownerDb.$executeRaw`DELETE FROM "ledger"."ledger_event" WHERE "event_id" = ${e.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        ownerDb.$executeRaw`UPDATE "shell"."audit_log" SET "action" = 'x' WHERE "id" = ${row.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(ownerDb.$executeRaw`TRUNCATE "shell"."audit_log"`).rejects.toThrow(/append-only/);
    } finally {
      await ownerDb.$disconnect();
    }
  });

  it("rejects an event without evidence at the database", async () => {
    await expect(
      db.ledgerEvent.create({ data: { ...event("no-evidence"), evidenceRefs: [] } }),
    ).rejects.toThrow(/ledger_event_has_evidence/);
  });

  it("reverses an event exactly, once", async () => {
    const { event: e } = await postEvent(db, event("to-reverse"));
    const input = {
      uniquenessKey: `${run}:to-reverse:REV`,
      occurredAt: new Date("2026-05-01"),
      portalUserId: "test",
      evidenceRefs: [evidenceId],
      reason: "test",
    };
    const { event: r } = await reverseEvent(db, e.id, input);
    expect(r.principalAmount).toBe(-1_000_000n);
    expect((await reverseEvent(db, e.id, input)).created).toBe(false);
    await expect(reverseEvent(db, e.id, { ...input, uniquenessKey: `${run}:other` })).rejects.toThrow(
      /already reversed/,
    );
  });
});
