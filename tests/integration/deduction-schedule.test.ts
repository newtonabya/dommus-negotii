/**
 * The deduction schedule sent to the payroll office, against the test
 * database. Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt } from "node:crypto";
import ExcelJS from "exceljs";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { localDate } from "@/lib/dates";
import { bps, kobo } from "@/lib/money";
import { planSchedule } from "@/modules/credit/domain/schedule";
import { toDbDate } from "@/modules/credit/loans/common";
import { placeholderEmail } from "@/modules/credit/members/rules";
import { deductionMonth, deductionSchedule, deductionXlsx, scheduleRows } from "@/modules/credit/reports/deduction-schedule";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(200_000);

describe("deduction month", () => {
  it("takes an instalment from the last salary before it falls due", () => {
    // Salaries on the 25th: due on the 10th → the month before; due on the 28th → the same month.
    expect(deductionMonth(localDate("2031-04-10"), 25)).toBe("2031-03");
    expect(deductionMonth(localDate("2031-04-28"), 25)).toBe("2031-04");
    expect(deductionMonth(localDate("2031-01-01"), 25)).toBe("2030-12");
  });
});

describeDb("deduction schedule for the bursary", () => {
  let db: PrismaClient;
  let sourceId: string;

  async function member(name: string, staffNo: string | null) {
    const userId = randomBytes(16).toString("hex");
    const phone = `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
    await db.user.create({ data: { id: userId, name, email: placeholderEmail(phone), phoneNumber: phone } });
    return db.member.create({
      data: { userId, fullName: name, phone, address: "Makurdi", moaumIdNumber: `MA-${randomInt(1e7, 9e7)}`, nextOfKinName: "K", nextOfKinPhone: "+2347010000000", status: "ACTIVE", remittanceSourceId: sourceId, payrollStaffNo: staffNo },
    });
  }
  const loan = (memberId: string, principal: bigint, tenure: number, d0: string) =>
    db.loan.create({
      data: { loanAccountNo: `CSS-D${randomInt(1e7, 9e7)}`, memberId, status: "ACTIVE", purpose: "Test", amountRequested: principal, tenureRequested: tenure, amountApproved: principal, tenureApproved: tenure, rateBps: 750, d0: toDbDate(localDate(d0)), createdById: "test" },
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
    sourceId = (await db.remittanceSource.create({ data: { code: `DED-${randomInt(1e5, 9e5)}`, name: "Deduction test payroll", createdById: "test" } })).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("lists every member month by month with the reducing-balance amounts, one combined figure per member, in the bursary's six columns", async () => {
    const a = await member("Babana Useful", "S01239");
    const b = await member("Two Loans", "S02000");
    const c = await member("No Staff Number", null);
    await loan(a.id, 10_000_000n, 10, "2031-03-10");
    await loan(b.id, 10_000_000n, 10, "2031-03-10");
    await loan(b.id, 6_000_000n, 2, "2031-03-10");
    await loan(c.id, 5_000_000n, 2, "2031-03-10");

    const schedule = await deductionSchedule(db, sourceId, "2031-03", localDate("2031-03-12"));
    // Member A's rows are exactly the loan engine's schedule (AT-a: ₦141,250 in all), from March to December.
    const planned = planSchedule({ principal: kobo(10_000_000n), tenure: 10, rate: bps(750n), d0: localDate("2031-03-10") });
    const rowsA = schedule.rows.filter((r) => r.memberId === a.id);
    expect(rowsA.map((r) => r.amount)).toEqual(planned.installments.map((i) => BigInt(i.amount)));
    expect(rowsA.map((r) => r.month)).toEqual(["2031-03", "2031-04", "2031-05", "2031-06", "2031-07", "2031-08", "2031-09", "2031-10", "2031-11", "2031-12"]);
    expect(rowsA.reduce((t, r) => t + r.amount, 0n)).toBe(14_125_000n);
    expect(rowsA[0]).toMatchObject({ name: "BABANA USEFUL", staffNo: "S01239", amount: 1_750_000n });

    // Two loans, one figure a month: 17,500 + (30,000 + 4,500) in March.
    const two = schedule.members.find((m) => m.memberId === b.id);
    expect(two).toMatchObject({ thisMonth: 1_750_000n + 3_450_000n, isNew: true, isFinal: false, lastMonth: "2031-12" });
    expect(two?.loans).toHaveLength(2);
    expect(schedule.rows.filter((r) => r.memberId === b.id && r.month === "2031-03")).toHaveLength(1);

    // Nobody without a staff number goes on a payroll file; the screen names them instead.
    expect(schedule.missingStaffNo).toEqual(["No Staff Number"]);
    expect(schedule.rows.some((r) => r.memberId === c.id)).toBe(false);

    // The file: one sheet, the six headers, year-month numbers, amounts in naira.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await deductionXlsx(scheduleRows(schedule, "month"))) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0] as ExcelJS.Worksheet;
    expect(wb.worksheets).toHaveLength(1);
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(["SN", "NAME", "PNO", "AMOUNT", "STARTDATE", "ENDDATE"]);
    expect((ws.getRow(2).values as unknown[]).slice(1)).toEqual([1, "BABANA USEFUL", "S01239", 17500, 203103, 203103]);
    expect(ws.rowCount).toBe(3); // header + the two members with staff numbers
  });

  it("adds what is overdue to the first month and keeps a member on the list until the loan is cleared", async () => {
    const late = await member("Late Payer", "S03000");
    await loan(late.id, 10_000_000n, 2, "2031-03-10");
    // Mid-June: both instalments (due 10 April and 10 May) have passed unpaid, and the tenure is over.
    const schedule = await deductionSchedule(db, sourceId, "2031-06", localDate("2031-06-15"));
    const m = schedule.members.find((x) => x.memberId === late.id);
    expect(m?.arrears).toBeGreaterThanOrEqual(10_000_000n);
    expect(m?.thisMonth).toBe(m?.total);
    expect(m).toMatchObject({ isFinal: true, lastMonth: "2031-06" });
    expect(schedule.rows.filter((r) => r.memberId === late.id)).toEqual([expect.objectContaining({ month: "2031-06", staffNo: "S03000" })]);
  });
});
