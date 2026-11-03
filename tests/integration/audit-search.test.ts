/**
 * Audit search and Excel export against the test database (PRD F2 DoD).
 * Each run writes its own entries under a unique action name. Skipped when
 * TEST_DATABASE_URL is not set.
 */
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { localDate } from "@/lib/dates";
import { AUDIT_PAGE_SIZE, exportAudit, parseAuditFilters, searchAudit } from "@/shell/audit/search";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

describe("audit filters from the query string", () => {
  it("parses dates and rejects bad ones", () => {
    expect(parseAuditFilters({ from: "2026-11-01", to: "2026-11-30", action: " a.b " })).toEqual({
      filters: { from: "2026-11-01", to: "2026-11-30", action: "a.b" },
      errors: [],
    });
    expect(parseAuditFilters({ from: "2026-13-01" }).errors).toEqual(["From: enter a date as YYYY-MM-DD."]);
    expect(parseAuditFilters({ from: "2026-11-30", to: "2026-11-01" }).errors).toEqual(["From must be on or before To."]);
  });
});

describeDb("audit search", () => {
  let db: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const action = `test.audit_search.${run}`;
  const userId = `auditor-test-${run}`;
  const recordId = randomUUID();

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
    // 55 entries spread over three Lagos days, one about a specific record.
    await db.auditLog.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        action,
        entityType: "TestRecord",
        entityId: i === 0 ? recordId : randomUUID(),
        userId,
        ipAddress: "127.0.0.1",
        // 23:30 UTC is 00:30 the next day in Lagos.
        occurredAt: new Date(Date.UTC(2026, 9, 10 + (i % 3), 23, 30, i)),
        after: { n: i },
      })),
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("filters by action and user, newest first, 50 per page", async () => {
    const page1 = await searchAudit(db, { action, user: userId }, 1);
    expect(page1.total).toBe(55);
    expect(page1.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(page1.pages).toBe(2);
    const times = page1.rows.map((r) => r.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(page1.rows[0]?.actor.name).toBe("Unknown user");
    expect(page1.actions).toContain(action);

    const page2 = await searchAudit(db, { action, user: userId }, 2);
    expect(page2.rows).toHaveLength(5);
  });

  it("filters by Lagos date and by record", async () => {
    // Entries at 23:30 UTC on 10 Oct fall on 11 Oct in Lagos.
    const day = await searchAudit(db, { action, from: localDate("2026-10-11"), to: localDate("2026-10-11") });
    expect(day.total).toBe(19);
    const record = await searchAudit(db, { action, entityId: recordId });
    expect(record.total).toBe(1);
    expect(await searchAudit(db, { action, user: "nobody-like-this" }).then((r) => r.total)).toBe(0);
  });

  it("exports the matching entries to Excel", async () => {
    const { bytes, total, included } = await exportAudit(db, { action }, "Test Auditor");
    expect([total, included]).toEqual([55, 55]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const sheet = workbook.getWorksheet("Audit trail");
    expect(sheet?.rowCount).toBe(56);
    expect(sheet?.getRow(1).getCell(7).value).toBe("Action");
    expect(sheet?.getRow(2).getCell(7).value).toBe(action);
    const about = workbook.getWorksheet("About this export");
    const items = about?.getColumn(1).values ?? [];
    expect(items).toContain("Exported by");
    expect(items).toContain("Filter: action");
  });
});
