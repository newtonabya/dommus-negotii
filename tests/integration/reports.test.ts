/**
 * Staff reports (PRD F13) against the test database: report totals tie back
 * to ledger sums, and every report renders to Excel and PDF.
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomInt, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { localDate } from "@/lib/dates";
import { postEvent, reverseEvent } from "@/ledger/post";
import { monthRange } from "@/modules/credit/reports/dashboard";
import { parsePeriod, reportByKey, reportPdf, REPORTS, reportXlsx } from "@/modules/credit/reports/staff-reports";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(300_000);

describe("parsePeriod", () => {
  it("defaults to the year to date and swaps a reversed range", () => {
    expect(parsePeriod("2026-03-31", "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(parsePeriod("not a date", "2026-02-10").to).toBe("2026-02-10");
  });
});

describeDb("staff reports (F13)", () => {
  let db: PrismaClient;

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
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("ties report totals back to ledger sums", async () => {
    // A month of its own, far ahead: test rows can't be deleted.
    const month = `${randomInt(2300, 2900)}-08`;
    const on = new Date(`${month}-12T00:00:00Z`);
    const evidence = [randomUUID()];
    const base = { occurredAt: on, moduleCode: "CREDIT", evidenceRefs: evidence, portalUserId: `reports-${randomUUID()}`, metadata: {} } as const;
    const loan = randomUUID();
    const k = (s: string) => `TEST:REPORTS:${month}:${randomUUID()}:${s}`;
    const interest = await postEvent(db, { ...base, eventType: "INTEREST_INCOME", source: "REMITTANCE_SCHEDULE", moduleEntityType: "Loan", moduleEntityId: loan, interestAmount: 410_000n, revenueAmount: 410_000n, uniquenessKey: k("i") });
    await postEvent(db, { ...base, eventType: "INTEREST_INCOME", source: "REMITTANCE_SCHEDULE", moduleEntityType: "Loan", moduleEntityId: loan, interestAmount: 90_000n, revenueAmount: 90_000n, uniquenessKey: k("i2") });
    await postEvent(db, { ...base, eventType: "PRINCIPAL_RECOVERY", source: "REMITTANCE_SCHEDULE", moduleEntityType: "Loan", moduleEntityId: loan, principalAmount: 2_000_000n, uniquenessKey: k("p") });
    await reverseEvent(db, interest.event.id, { uniquenessKey: k("r"), occurredAt: on, portalUserId: base.portalUserId, evidenceRefs: evidence, reason: "test" });

    const period = monthRange(month);
    const range = { gte: new Date(`${period.from}T00:00:00Z`), lte: new Date(`${period.to}T00:00:00Z`) };

    const income = await reportByKey("interest-income")!.build(db, period);
    const revenue = await db.ledgerEvent.aggregate({ where: { moduleCode: "CREDIT", occurredAt: range }, _sum: { revenueAmount: true } });
    expect(income.totals?.[3]).toBe(revenue._sum.revenueAmount);
    expect(income.totals?.[3]).toBe(90_000n);
    expect(income.totals?.[2]).toBe(-410_000n);

    const ledger = await reportByKey("ledger")!.build(db, period);
    const sums = await db.ledgerEvent.aggregate({ where: { occurredAt: range }, _sum: { cashAmount: true, revenueAmount: true, principalAmount: true, interestAmount: true, depositDelta: true } });
    expect(ledger.totals?.slice(6, 11)).toEqual([sums._sum.cashAmount, sums._sum.revenueAmount, sums._sum.principalAmount, sums._sum.interestAmount, sums._sum.depositDelta]);
    expect(ledger.rows).toHaveLength(4);

    // As-at reports tie to the whole ledger.
    const credits = await reportByKey("overpayment-credits")!.build(db, period);
    const deposits = await db.ledgerEvent.groupBy({ by: ["eventType"], where: { moduleEntityType: "Member", eventType: { in: ["DEPOSIT_CREDITED", "DEPOSIT_REFUNDED"] } }, _sum: { depositDelta: true } });
    const net = deposits.reduce((t, g) => t + (g.eventType === "DEPOSIT_REFUNDED" ? -(g._sum.depositDelta ?? 0n) : (g._sum.depositDelta ?? 0n)), 0n);
    expect(credits.totals?.[4]).toBe(net);

    const register = await reportByKey("active-loans")!.build(db, period);
    const active = await db.loan.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
    const principal = await db.ledgerEvent.groupBy({
      by: ["eventType"],
      where: { moduleEntityType: "Loan", moduleEntityId: { in: active.map((l) => l.id) }, eventType: { in: ["CASH_OUT", "OPENING_BALANCE", "PRINCIPAL_RECOVERY"] } },
      _sum: { principalAmount: true },
    });
    const outstanding = principal.reduce((t, g) => t + (g.eventType === "PRINCIPAL_RECOVERY" ? -(g._sum.principalAmount ?? 0n) : (g._sum.principalAmount ?? 0n)), 0n);
    expect(register.totals?.[8]).toBe(outstanding);
  });

  it("renders every report to Excel and PDF", async () => {
    const period = { from: localDate("2026-01-01"), to: localDate("2026-12-31") };
    for (const def of REPORTS) {
      const report = await def.build(db, def.key === "ledger" ? monthRange("2026-11") : period);
      const xlsx = await reportXlsx(report);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer);
      expect(wb.worksheets[0]?.getRow(4).getCell(1).value).toBe(report.columns[0]?.header);
      expect((await reportPdf(report, def.landscape)).length).toBeGreaterThan(1000);
    }
  });
});
