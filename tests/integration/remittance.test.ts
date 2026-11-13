/**
 * Remittance schedules, Track A (PRD F9) against the test database:
 * Source Advice, dry run, commit and posting, and the batch rejections.
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { addDays, localDate, todayInLagos } from "@/lib/dates";
import { LocalEvidenceStore } from "@/evidence/store";
import { createBankAccount } from "@/modules/credit/banking/bank-accounts";
import { toDbDate } from "@/modules/credit/loans/common";
import { loanLiveState } from "@/modules/credit/loans/repayments";
import { loanStatementPdf, payoffQuotePdf, receiptPdf, receiptToken, verifyReceipt } from "@/modules/credit/reports/member-documents";
import { RemittanceError } from "@/modules/credit/remittance/common";
import { commitSchedule, loadSchedulePreview, previewSchedule, type ScheduleHeaderInput } from "@/modules/credit/remittance/schedules";
import { uploadSourceAdvice } from "@/modules/credit/remittance/source-advice";
import { prepareCorrection, returnCorrection, verifyCorrection } from "@/modules/credit/remittance/corrections";
import { MemberError } from "@/modules/credit/members/invitations";
import { setPayrollStaffNo } from "@/modules/credit/members/review";
import { placeholderEmail } from "@/modules/credit/members/rules";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(240_000);

const today = todayInLagos();
/** Last month: payment dates must not be after its last day nor in the future. */
const lastMonthEnd = addDays(localDate(`${today.slice(0, 7)}-01`), -1);
const month = lastMonthEnd.slice(0, 7);
const payDay = localDate(`${month}-25`);
const d0 = addDays(payDay, -70);

type Row = Partial<Record<"row_type" | "member_moaum_id" | "member_name" | "loan_account_no" | "amount_paid" | "payment_date" | "row_note", string>>;
type Lodgement = Record<"bank_account" | "deposit_date" | "reference" | "amount", string>;

async function scheduleFile(rows: Row[], lodgements: Lodgement[] = []) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Rows");
  const cols = ["row_type", "member_moaum_id", "member_name", "loan_account_no", "amount_paid", "payment_date", "period_covered", "receipt_no", "bank_credit_ref", "row_note"];
  sheet.addRow(cols);
  for (const r of rows) sheet.addRow(cols.map((c) => (r as Record<string, string>)[c] ?? (c === "row_type" ? "PAYROLL" : c === "payment_date" ? payDay : "")));
  const l = wb.addWorksheet("Lodgements");
  l.addRow(["bank_account", "deposit_date", "reference", "amount", "depositor", "note"]);
  for (const x of lodgements) l.addRow([x.bank_account, x.deposit_date, x.reference, x.amount, "Payroll office", ""]);
  return { filename: `schedule-${randomUUID()}.xlsx`, bytes: new Uint8Array(await wb.xlsx.writeBuffer()) };
}

describeDb("remittance schedules (F9)", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  let sourceCode: string;
  let sourceId: string;
  let accountNumber: string;
  const finance = { id: `fm-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const treasurer = { id: `tr-${randomUUID()}`, ipAddress: "127.0.0.1" };

  async function newMember(status: "ACTIVE" | "PENDING" = "ACTIVE") {
    const userId = randomBytes(16).toString("hex");
    const p = `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
    await db.user.create({ data: { id: userId, name: "Member", email: placeholderEmail(p), phoneNumber: p } });
    return db.member.create({
      data: {
        userId,
        fullName: `Member ${randomInt(1000, 9999)}`,
        phone: p,
        address: "5 Ogiri Oko Road, Makurdi",
        moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`,
        nextOfKinName: "Ada Okeke",
        nextOfKinPhone: "+2347010000000",
        status,
      },
    });
  }

  async function newLoan(memberId: string, status: "ACTIVE" | "CLOSED" = "ACTIVE", principal = 30_000_000n) {
    return db.loan.create({
      data: {
        loanAccountNo: `CSS-T${randomInt(1e7, 9e7)}`,
        memberId,
        status,
        purpose: "Test loan",
        amountRequested: principal,
        tenureRequested: 6,
        amountApproved: principal,
        tenureApproved: 6,
        rateBps: 750,
        d0: toDbDate(d0),
        createdById: "test",
      },
    });
  }

  async function advice(lines: Array<{ id: string; amount: string }>, total?: string) {
    const ref = `ADV-${randomInt(1e6, 9e6)}`;
    const csv = ["member_moaum_id,member_name,amount", ...lines.map((l) => `${l.id},Someone,${l.amount}`)].join("\n");
    const sum = lines.reduce((t, l) => t + Number(l.amount), 0);
    await uploadSourceAdvice(
      db,
      store,
      finance,
      { remittanceSource: sourceCode, monthCovered: month, adviceReference: ref, controlTotal: total ?? String(sum), rowCount: String(lines.length) },
      { filename: "advice.csv", bytes: new TextEncoder().encode(csv) },
      { filename: "source-letter.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) },
    );
    return ref;
  }

  const header = (adviceReference: string, controlTotal: string, rowCount: number, over: Partial<ScheduleHeaderInput> = {}): ScheduleHeaderInput => ({
    scheduleReference: `SCH-${randomInt(1e6, 9e6)}`,
    remittanceSource: sourceCode,
    monthCovered: month,
    scheduleType: "SUPPLEMENTARY",
    adviceReference,
    submittedBy: "Payroll office",
    controlTotal,
    rowCount: String(rowCount),
    ...over,
  });

  beforeAll(async () => {
    process.env.RECEIPT_SECRET ??= "test-receipt-secret";
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
    dir = await mkdtemp(path.join(tmpdir(), "remit-"));
    store = new LocalEvidenceStore(dir, "test-secret");
    sourceCode = `PAY-${randomInt(1e5, 9e5)}`;
    sourceId = (await db.remittanceSource.create({ data: { code: sourceCode, name: "Test payroll", createdById: "test" } })).id;
    accountNumber = String(randomInt(1e9, 9.99e9)).slice(0, 10);
    await createBankAccount(db, { id: "admin", ipAddress: null }, { bankName: "Test Bank", branch: "", accountName: "MOAUM", accountNumber });
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("checks a Source Advice's totals and members before saving it", async () => {
    const a = await newMember();
    await expect(advice([{ id: a.moaumIdNumber, amount: "10000" }], "12000")).rejects.toThrow(RemittanceError);
    await expect(advice([{ id: "MA-NOBODY", amount: "10000" }])).rejects.toMatchObject({ details: [expect.stringMatching(/not in the register/)] });
    await expect(
      advice([
        { id: a.moaumIdNumber, amount: "5000" },
        { id: a.moaumIdNumber, amount: "5000" },
      ]),
    ).rejects.toMatchObject({ details: [expect.stringMatching(/one row per member/)] });
  });

  it("[AT-c][AT-p] posts a valid schedule with no verification gate: loan rows allocated, closed-loan and no-loan rows to Overpayment Credit", async () => {
    const a = await newMember();
    const b = await newMember();
    const c = await newMember();
    const loanA = await newLoan(a.id);
    const closedB = await newLoan(b.id, "CLOSED");
    const ref = await advice([
      { id: a.moaumIdNumber, amount: "60000" },
      { id: b.moaumIdNumber, amount: "15000" },
      { id: c.moaumIdNumber, amount: "2500" },
    ]);
    const file = await scheduleFile(
      [
        { member_moaum_id: a.moaumIdNumber, member_name: a.fullName, amount_paid: "60000" },
        { member_moaum_id: b.moaumIdNumber, member_name: b.fullName, loan_account_no: closedB.loanAccountNo ?? "", amount_paid: "15000" },
        { member_moaum_id: c.moaumIdNumber, member_name: c.fullName, amount_paid: "2500" },
      ],
      [{ bank_account: accountNumber, deposit_date: payDay, reference: `SLIP-${randomInt(1e6, 9e6)}`, amount: "77500" }],
    );
    const h = header(ref, "77,500", 3);
    const preview = await previewSchedule(db, store, treasurer, h, file);
    const shown = await loadSchedulePreview(db, preview.batchId);
    expect(shown?.stored.batchErrors).toEqual([]);
    expect(preview.ok).toBe(true);
    const rowA = shown?.rows.find((r) => r.rowNo === 2)?.plan;
    expect(rowA?.loanId).toBe(loanA.id);
    expect(BigInt(rowA?.split?.interest ?? "0") + BigInt(rowA?.split?.principal ?? "0")).toBe(6_000_000n);
    expect(shown?.rows.find((r) => r.rowNo === 3)?.plan).toMatchObject({ toCredit: true, creditReason: expect.stringMatching(/closed/) });
    expect(shown?.rows.find((r) => r.rowNo === 4)?.plan).toMatchObject({ toCredit: true, creditReason: "No active loan" });
    expect(shown?.stored.totals.lodged).toBe("7750000");

    const result = await commitSchedule(db, treasurer, preview.batchId);
    expect(result).toMatchObject({ rows: 3, credited: 2 });
    const schedule = await db.remittanceSchedule.findUniqueOrThrow({ where: { id: result.scheduleId }, include: { rows: true, lodgements: true, advice: true } });
    expect(schedule.advice?.status).toBe("USED");
    expect(schedule.lodgements).toHaveLength(1);
    expect(schedule.lodgements[0]?.status).toBe("UNVERIFIED");
    expect(schedule.checksum).toMatch(/^[0-9a-f]{64}$/);

    const loanEvents = await db.ledgerEvent.findMany({ where: { moduleEntityType: "Loan", moduleEntityId: loanA.id } });
    const principal = loanEvents.filter((e) => e.eventType === "PRINCIPAL_RECOVERY").reduce((t, e) => t + e.principalAmount, 0n);
    const interest = loanEvents.filter((e) => e.eventType === "INTEREST_INCOME").reduce((t, e) => t + e.interestAmount, 0n);
    expect(principal + interest).toBe(6_000_000n);
    expect(loanEvents.every((e) => e.source === "REMITTANCE_SCHEDULE")).toBe(true);
    for (const m of [b, c]) {
      const credited = await db.ledgerEvent.findFirstOrThrow({ where: { moduleEntityType: "Member", moduleEntityId: m.id, eventType: "DEPOSIT_CREDITED" } });
      expect(credited.depositDelta).toBe(m === b ? 1_500_000n : 250_000n);
    }
    const status = await db.ledgerEvent.findMany({ where: { moduleEntityId: result.scheduleId } });
    expect(status.map((e) => e.eventType).sort()).toEqual(["SCHEDULE_ACCEPTED", "SCHEDULE_POSTED"]);
    expect(status.find((e) => e.eventType === "SCHEDULE_ACCEPTED")?.metadata).toMatchObject({ amount: "7750000" });

    // Member documents (PRD F13): statement, payoff quote and a receipt that verifies.
    const statementPdf = await loanStatementPdf(db, loanA.id, today);
    expect(statementPdf.bytes.length).toBeGreaterThan(2000);
    expect((await payoffQuotePdf(db, loanA.id, today)).quote.amount).toBeGreaterThan(0n);
    const rowOfA = schedule.rows.find((r) => r.memberId === a.id)!;
    expect((await receiptPdf(db, rowOfA.id)).bytes.length).toBeGreaterThan(1000);
    expect(await verifyReceipt(db, receiptToken(rowOfA.id))).toMatchObject({ genuine: true, amount: "₦60,000.00", reversed: false });
    expect(await verifyReceipt(db, `${rowOfA.id}.AAAAAAAAAAAA`)).toEqual({ genuine: false });

    const live = await loanLiveState(db, loanA, today);
    expect(live?.repayments).toHaveLength(1);
    expect(live?.repayments[0]?.amount).toBe(6_000_000n);
    expect(live?.payoff?.amount).toBeGreaterThan(0n);

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "schedule.commit", entityId: result.scheduleId } });
    expect(audit.userId).toBe(treasurer.id);

    // The same reference cannot be posted twice for the source.
    const again = await previewSchedule(db, store, treasurer, { ...h, adviceReference: await advice([{ id: c.moaumIdNumber, amount: "1000" }]), controlTotal: "1000", rowCount: "1" }, await scheduleFile([{ member_moaum_id: c.moaumIdNumber, member_name: "C", amount_paid: "1000" }]));
    expect((await loadSchedulePreview(db, again.batchId))?.stored.batchErrors).toEqual([expect.stringMatching(/already posted/)]);
  });

  it("[AT-d] rejects a schedule whose rows don't sum to the control total, as a whole", async () => {
    const a = await newMember();
    await newLoan(a.id);
    const ref = await advice([{ id: a.moaumIdNumber, amount: "20000" }]);
    const preview = await previewSchedule(db, store, treasurer, header(ref, "25000", 1), await scheduleFile([{ member_moaum_id: a.moaumIdNumber, member_name: "A", amount_paid: "20000" }]));
    expect(preview.ok).toBe(false);
    expect((await loadSchedulePreview(db, preview.batchId))?.stored.batchErrors).toEqual([expect.stringMatching(/total ₦20,000.00 but the control total is ₦25,000.00/)]);
    await expect(commitSchedule(db, treasurer, preview.batchId)).rejects.toThrow(/Nothing was posted/);
    expect(await db.remittanceRow.count({ where: { memberId: a.id } })).toBe(0);
    expect((await db.importBatch.findUniqueOrThrow({ where: { id: preview.batchId } })).status).toBe("REJECTED");
  });

  it("[AT-e] rejects the whole batch for an unknown member or a loan that is not the member's, with no partial writes", async () => {
    const a = await newMember();
    const b = await newMember();
    const pending = await newMember("PENDING");
    await newLoan(a.id);
    const otherLoan = await newLoan(b.id);
    const ref = await advice([
      { id: a.moaumIdNumber, amount: "10000" },
      { id: b.moaumIdNumber, amount: "10000" },
    ]);
    const preview = await previewSchedule(
      db,
      store,
      treasurer,
      header(ref, "30000", 3),
      await scheduleFile([
        { member_moaum_id: a.moaumIdNumber, member_name: "A", loan_account_no: otherLoan.loanAccountNo ?? "", amount_paid: "10000" },
        { member_moaum_id: b.moaumIdNumber, member_name: "B", amount_paid: "10000" },
        { member_moaum_id: "MA-0000000", member_name: "Ghost", amount_paid: "5000" },
      ]),
    );
    const shown = await loadSchedulePreview(db, preview.batchId);
    expect(shown?.rows[0]?.errors).toEqual(expect.arrayContaining([expect.stringMatching(/does not belong to this member/)]));
    expect(shown?.rows[2]?.errors).toEqual(expect.arrayContaining([expect.stringMatching(/not in the register/)]));
    await expect(commitSchedule(db, treasurer, preview.batchId)).rejects.toThrow(RemittanceError);
    expect(await db.remittanceRow.count({ where: { memberId: { in: [a.id, b.id] } } })).toBe(0);
    expect(await db.ledgerEvent.count({ where: { moduleEntityId: otherLoan.id, eventType: { in: ["PRINCIPAL_RECOVERY", "INTEREST_INCOME"] } } })).toBe(0);

    const p2 = await previewSchedule(db, store, treasurer, header(ref, "1000", 1), await scheduleFile([{ member_moaum_id: pending.moaumIdNumber, member_name: "P", amount_paid: "1000" }]));
    expect((await loadSchedulePreview(db, p2.batchId))?.rows[0]?.errors).toEqual(expect.arrayContaining([expect.stringMatching(/pending, not an active member/)]));
  });

  it("[AT-l] rejects a schedule that matches the total but moves ₦2,500 between members against the Source Advice", async () => {
    const x = await newMember();
    const y = await newMember();
    await newLoan(x.id);
    await newLoan(y.id);
    const ref = await advice([
      { id: x.moaumIdNumber, amount: "10000" },
      { id: y.moaumIdNumber, amount: "10000" },
    ]);
    const preview = await previewSchedule(
      db,
      store,
      treasurer,
      header(ref, "20000", 2),
      await scheduleFile([
        { member_moaum_id: x.moaumIdNumber, member_name: "X", amount_paid: "7500" },
        { member_moaum_id: y.moaumIdNumber, member_name: "Y", amount_paid: "12500" },
      ]),
    );
    expect(preview.ok).toBe(false);
    const shown = await loadSchedulePreview(db, preview.batchId);
    expect(shown?.stored.batchErrors).toEqual([]);
    expect(shown?.rows.map((r) => r.errors)).toEqual([
      [expect.stringMatching(/Advice says ₦10,000.00 for this member; the schedule's rows total ₦7,500.00/)],
      [expect.stringMatching(/Advice says ₦10,000.00 for this member; the schedule's rows total ₦12,500.00/)],
    ]);
    expect(shown?.stored.adviceMatch.filter((m) => !m.ok)).toHaveLength(2);
    await expect(commitSchedule(db, treasurer, preview.batchId)).rejects.toThrow(/Nothing was posted/);
  });

  it("[AT-i] rejects a duplicate row, a DIRECT row and a member missing from the schedule", async () => {
    const a = await newMember();
    const b = await newMember();
    await newLoan(a.id);
    const ref = await advice([
      { id: a.moaumIdNumber, amount: "10000" },
      { id: b.moaumIdNumber, amount: "3000" },
    ]);
    const row = { member_moaum_id: a.moaumIdNumber, member_name: "A", amount_paid: "5000" };
    const preview = await previewSchedule(
      db,
      store,
      treasurer,
      header(ref, "13000", 3),
      await scheduleFile([row, row, { ...row, row_type: "DIRECT", amount_paid: "3000" }]),
    );
    const shown = await loadSchedulePreview(db, preview.batchId);
    expect(shown?.rows[1]?.errors).toEqual(expect.arrayContaining([expect.stringMatching(/duplicate row/)]));
    expect(shown?.rows[2]?.errors).toEqual(expect.arrayContaining([expect.stringMatching(/bank_credit_ref: required on a DIRECT row/)]));
    expect(shown?.stored.batchErrors).toEqual([expect.stringMatching(/on the Source Advice for ₦3,000.00 but not on the schedule/)]);
  });

  it("rolls back everything when the commit fails mid-batch, and posts cleanly on retry", async () => {
    const a = await newMember();
    const c = await newMember();
    const loan = await newLoan(a.id);
    const ref = await advice([
      { id: a.moaumIdNumber, amount: "50000" },
      { id: c.moaumIdNumber, amount: "1000" },
    ]);
    const preview = await previewSchedule(
      db,
      store,
      treasurer,
      header(ref, "51000", 2),
      await scheduleFile([
        { member_moaum_id: a.moaumIdNumber, member_name: "A", amount_paid: "50000" },
        { member_moaum_id: c.moaumIdNumber, member_name: "C", amount_paid: "1000" },
      ]),
    );
    expect(preview.ok).toBe(true);
    await expect(
      commitSchedule(db, treasurer, preview.batchId, {
        beforeFinish: async () => {
          throw new Error("forced failure");
        },
      }),
    ).rejects.toThrow("forced failure");
    expect(await db.remittanceRow.count({ where: { memberId: { in: [a.id, c.id] } } })).toBe(0);
    expect(await db.ledgerEvent.count({ where: { OR: [{ moduleEntityId: loan.id, source: "REMITTANCE_SCHEDULE" }, { moduleEntityId: c.id }] } })).toBe(0);
    expect((await db.sourceAdvice.findFirstOrThrow({ where: { adviceReference: ref } })).status).toBe("AVAILABLE");

    const result = await commitSchedule(db, treasurer, preview.batchId);
    expect(await db.remittanceRow.count({ where: { scheduleId: result.scheduleId } })).toBe(2);
  });

  it("posts a schedule the Treasurer uploads alone, with no Source Advice, and still refuses one that names a missing advice", async () => {
    const a = await newMember();
    const loan = await newLoan(a.id);
    const file = () => scheduleFile([{ member_moaum_id: a.moaumIdNumber, member_name: "A", amount_paid: "40000" }]);
    // Naming an advice that doesn't exist is still an error: the check is optional, not ignored.
    const bad = await previewSchedule(db, store, treasurer, header("ADV-DOES-NOT-EXIST", "40000", 1), await file());
    expect(bad.ok).toBe(false);

    const preview = await previewSchedule(db, store, treasurer, header("", "40000", 1), await file());
    expect(preview.ok).toBe(true);
    const result = await commitSchedule(db, treasurer, preview.batchId);
    const schedule = await db.remittanceSchedule.findUniqueOrThrow({ where: { id: result.scheduleId }, include: { rows: true } });
    expect(schedule.adviceId).toBeNull();
    expect(schedule.rows).toHaveLength(1);
    // The repayment took effect: the loan's allocations are in the ledger.
    const events = await db.ledgerEvent.findMany({ where: { moduleEntityId: loan.id, source: "REMITTANCE_SCHEDULE" } });
    expect(events.reduce((t, e) => t + e.principalAmount + e.interestAmount, 0n)).toBe(4_000_000n);
  });

  it("closes a loan repaid in full and credits the excess to the member", async () => {
    const a = await newMember();
    const loan = await newLoan(a.id, "ACTIVE", 10_000_000n);
    const ref = await advice([{ id: a.moaumIdNumber, amount: "150000" }]);
    const preview = await previewSchedule(db, store, treasurer, header(ref, "150000", 1), await scheduleFile([{ member_moaum_id: a.moaumIdNumber, member_name: "A", amount_paid: "150000" }]));
    expect(preview.ok).toBe(true);
    await commitSchedule(db, treasurer, preview.batchId);
    const closed = await db.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedOn?.toISOString().slice(0, 10)).toBe(payDay);
    const events = await db.ledgerEvent.findMany({ where: { OR: [{ moduleEntityId: loan.id }, { moduleEntityId: a.id }], source: "REMITTANCE_SCHEDULE" } });
    const total = events.reduce((t, e) => t + e.principalAmount + e.interestAmount + e.depositDelta, 0n);
    expect(total).toBe(15_000_000n);
    expect(events.filter((e) => e.eventType === "PRINCIPAL_RECOVERY").reduce((t, e) => t + e.principalAmount, 0n)).toBe(10_000_000n);
    const credit = events.find((e) => e.eventType === "DEPOSIT_CREDITED");
    expect(credit?.metadata).toMatchObject({ loanId: loan.id, kind: "OVERPAYMENT" });
    expect(credit?.depositDelta).toBeGreaterThan(0n);
  });

  it("takes the payroll voucher exactly as it arrives, matching members by their payroll staff number", async () => {
    const officer = { id: `lo-${randomUUID()}`, ipAddress: "127.0.0.1" };
    const x = await newMember();
    const y = await newMember();
    await db.member.updateMany({ where: { id: { in: [x.id, y.id] } }, data: { remittanceSourceId: sourceId } });
    const loanX = await newLoan(x.id);
    const [sx, sy] = [`S${randomInt(1e5, 9e5)}`, `J${randomInt(1e5, 9e5)}`];
    await setPayrollStaffNo(db, officer, x.id, sx.toLowerCase());
    await setPayrollStaffNo(db, officer, y.id, ` ${sy} `);
    await expect(setPayrollStaffNo(db, officer, y.id, sx)).rejects.toThrow(MemberError);
    expect((await db.member.findUniqueOrThrow({ where: { id: x.id } })).payrollStaffNo).toBe(sx);

    const monthName = new Date(`${month}-15T00:00:00Z`).toLocaleString("en-GB", { month: "long", timeZone: "UTC" }).toUpperCase();
    const voucher = async (title: string, lines: Array<[string, string, string, number]>) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Sheet1");
      ws.addRow([title]);
      ws.addRow(["S/NO", "STAFF NAME", "STAFF NO", "MOAUM CONSULTANCY"]);
      for (const l of lines) ws.addRow(l);
      ws.addRow(["", "TOTAL", "", lines.reduce((t, l) => t + l[3], 0)]);
      return { filename: `voucher-${randomUUID()}.xlsx`, bytes: new Uint8Array(await wb.xlsx.writeBuffer()) };
    };
    const lines: Array<[string, string, string, number]> = [
      ["839", `${x.fullName.toUpperCase()}       `, sx, 5375],
      ["716", `${y.fullName.toUpperCase()}       `, sy, 10000],
    ];
    const file = await voucher(`${monthName} ${month.slice(0, 4)} SALARY VOUCHER`, lines);
    const adviceInput = (ref: string) => ({ remittanceSource: sourceCode, monthCovered: month, adviceReference: ref, controlTotal: "15,375", rowCount: "2" });
    const doc = () => ({ filename: "payroll.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) });

    // A voucher for another month, or with a staff number nobody holds, is refused.
    await expect(uploadSourceAdvice(db, store, finance, adviceInput(`ADV-${randomInt(1e6, 9e6)}`), await voucher("JANUARY 2001 SALARY VOUCHER", lines), doc())).rejects.toThrow(/is for 2001-01/);
    await expect(
      uploadSourceAdvice(db, store, finance, adviceInput(`ADV-${randomInt(1e6, 9e6)}`), await voucher(`${monthName} ${month.slice(0, 4)} SALARY VOUCHER`, [lines[0] as [string, string, string, number], ["1", "NOBODY", "S99999999", 10000]]), doc()),
    ).rejects.toMatchObject({ details: [expect.stringMatching(/S99999999 .* is not linked to a member/)] });

    const ref = `ADV-${randomInt(1e6, 9e6)}`;
    await uploadSourceAdvice(db, store, finance, adviceInput(ref), file, doc());
    const header = { scheduleReference: `SCH-${randomInt(1e6, 9e6)}`, remittanceSource: sourceCode, monthCovered: month, scheduleType: "SUPPLEMENTARY", adviceReference: ref, submittedBy: "Payroll office", controlTotal: "15375", rowCount: "2" };
    await expect(previewSchedule(db, store, treasurer, header, file)).rejects.toThrow(/Payment date/);
    const preview = await previewSchedule(db, store, treasurer, { ...header, paymentDate: payDay }, { ...file, filename: `copy-${file.filename}` });
    const shown = await loadSchedulePreview(db, preview.batchId);
    expect(shown?.stored.batchErrors).toEqual([]);
    expect(preview.ok).toBe(true);
    expect(shown?.rows.map((r) => [r.plan?.memberId, r.plan?.loanId ?? null, r.plan?.toCredit])).toEqual([
      [x.id, loanX.id, false],
      [y.id, null, true],
    ]);
    const result = await commitSchedule(db, treasurer, preview.batchId);
    expect(result).toMatchObject({ rows: 2, credited: 1 });
    const posted = await db.ledgerEvent.findMany({ where: { moduleEntityType: "Loan", moduleEntityId: loanX.id, source: "REMITTANCE_SCHEDULE" } });
    expect(posted.reduce((t, e) => t + e.principalAmount + e.interestAmount, 0n)).toBe(537_500n);
  });

  describe("corrections", () => {
    const pdf = () => ({ filename: "letter.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) });
    const otherTreasurer = { id: `tr2-${randomUUID()}`, ipAddress: "127.0.0.1" };

    async function posted(rows: Row[], lines: Array<{ id: string; amount: string }>) {
      const ref = await advice(lines);
      const total = rows.reduce((t, r) => t + Number(r.amount_paid), 0);
      const preview = await previewSchedule(db, store, treasurer, header(ref, String(total), rows.length), await scheduleFile(rows));
      expect((await loadSchedulePreview(db, preview.batchId))?.stored.batchErrors).toEqual([]);
      const { scheduleId } = await commitSchedule(db, treasurer, preview.batchId);
      return db.remittanceSchedule.findUniqueOrThrow({ where: { id: scheduleId }, include: { rows: { orderBy: { rowNo: "asc" } }, advice: true } });
    }
    const loanTotal = async (loanId: string) =>
      (await db.ledgerEvent.findMany({ where: { moduleEntityType: "Loan", moduleEntityId: loanId, eventType: { in: ["PRINCIPAL_RECOVERY", "INTEREST_INCOME"] } } })).reduce(
        (t, e) => t + e.principalAmount + e.interestAmount,
        0n,
      );

    it("moves a payment posted to the wrong loan: Treasurer prepares, Finance Manager verifies, both loans recomputed", async () => {
      const a = await newMember();
      const wrong = await newLoan(a.id);
      const right = await newLoan(a.id);
      const schedule = await posted(
        [{ member_moaum_id: a.moaumIdNumber, member_name: "A", loan_account_no: wrong.loanAccountNo ?? "", amount_paid: "40000" }],
        [{ id: a.moaumIdNumber, amount: "40000" }],
      );
      expect(await loanTotal(wrong.id)).toBe(4_000_000n);
      const row = schedule.rows[0]!;
      const replacement = await scheduleFile([{ member_moaum_id: a.moaumIdNumber, member_name: "A", loan_account_no: right.loanAccountNo ?? "", amount_paid: "40000" }]);
      const input = { reason: "Payroll applied the deduction to the wrong loan", reverseRowIds: [row.id] };

      await expect(prepareCorrection(db, store, otherTreasurer, schedule.id, input, pdf(), replacement)).rejects.toThrow(/Only the Treasurer who posted/);
      await expect(prepareCorrection(db, store, treasurer, schedule.id, { ...input, reason: "short" }, pdf(), replacement)).rejects.toThrow(/at least 10/);
      const correction = await prepareCorrection(db, store, treasurer, schedule.id, input, pdf(), replacement);
      await expect(prepareCorrection(db, store, treasurer, schedule.id, input, pdf(), replacement)).rejects.toThrow(/already has a correction waiting/);
      expect(await loanTotal(wrong.id)).toBe(4_000_000n); // nothing posted yet
      await expect(verifyCorrection(db, treasurer, correction.id)).rejects.toThrow(/Someone else must verify/);

      const result = await verifyCorrection(db, finance, correction.id);
      expect(result).toMatchObject({ reversed: 1, added: 1 });
      expect(await loanTotal(wrong.id)).toBe(0n);
      expect(await loanTotal(right.id)).toBe(4_000_000n);
      const rows = await db.remittanceRow.findMany({ where: { scheduleId: schedule.id }, orderBy: { rowNo: "asc" } });
      expect(rows.map((r) => [r.rowNo, r.loanId, r.reversedAt !== null, r.correctionId])).toEqual([
        [row.rowNo, wrong.id, true, null],
        [row.rowNo + 1, right.id, false, correction.id],
      ]);
      expect((await db.correctionBatch.findUniqueOrThrow({ where: { id: correction.id } })).status).toBe("VERIFIED");
      await expect(verifyCorrection(db, finance, correction.id)).rejects.toThrow(/already been decided/);
    });

    it("needs a superseding advice when the source's own figures were wrong, and reverses Overpayment Credit", async () => {
      const a = await newMember();
      const b = await newMember(); // no loan: their row went to Overpayment Credit
      await newLoan(a.id);
      const schedule = await posted(
        [
          { member_moaum_id: a.moaumIdNumber, member_name: "A", amount_paid: "60000" },
          { member_moaum_id: b.moaumIdNumber, member_name: "B", amount_paid: "2500" },
        ],
        [
          { id: a.moaumIdNumber, amount: "60000" },
          { id: b.moaumIdNumber, amount: "2500" },
        ],
      );
      const [rowA, rowB] = schedule.rows;
      const replacement = async () => scheduleFile([{ member_moaum_id: a.moaumIdNumber, member_name: "A", amount_paid: "55000" }]);
      const input = { reason: "Payroll over-deducted A and wrongly deducted B", reverseRowIds: [rowA!.id, rowB!.id] };

      // Against the original advice the corrected rows don't match.
      await expect(prepareCorrection(db, store, treasurer, schedule.id, input, pdf(), await replacement())).rejects.toMatchObject({
        details: expect.arrayContaining([expect.stringMatching(/Advice says ₦60,000.00/), expect.stringMatching(/has no rows after the correction/)]),
      });

      // The Finance Manager uploads the source's corrected advice, superseding the used one.
      const ref = `ADV-${randomInt(1e6, 9e6)}`;
      const csv = new TextEncoder().encode(["member_moaum_id,member_name,amount", `${a.moaumIdNumber},A,55000`].join("\n"));
      const base = { remittanceSource: sourceCode, monthCovered: month, adviceReference: ref, controlTotal: "55000", rowCount: "1", supersedes: schedule.adviceId as string };
      await expect(uploadSourceAdvice(db, store, finance, { ...base, supersedeReason: "" }, { filename: "a.csv", bytes: csv }, pdf())).rejects.toThrow(/Say why/);
      const corrected = await uploadSourceAdvice(db, store, finance, { ...base, supersedeReason: "Payroll office sent a corrected deduction list" }, { filename: "a.csv", bytes: csv }, pdf());
      expect(corrected.status).toBe("AVAILABLE");
      // It is reserved for this schedule's correction, not a new schedule.
      const c = await newMember();
      const attempt = await previewSchedule(db, store, treasurer, header(ref, "55000", 1), await scheduleFile([{ member_moaum_id: c.moaumIdNumber, member_name: "C", amount_paid: "55000" }]));
      expect((await loadSchedulePreview(db, attempt.batchId))?.stored.batchErrors).toEqual(expect.arrayContaining([expect.stringMatching(/correction, not a new schedule/)]));

      const returned = await prepareCorrection(db, store, treasurer, schedule.id, input, pdf(), await replacement());
      await expect(returnCorrection(db, finance, returned.id, "no")).rejects.toThrow(/Say why/);
      await returnCorrection(db, finance, returned.id, "Attach the payroll office's letter");
      const correction = await prepareCorrection(db, store, treasurer, schedule.id, input, pdf(), await replacement());

      // A failure mid-way leaves everything as it was.
      await expect(verifyCorrection(db, finance, correction.id, { beforeFinish: async () => Promise.reject(new Error("forced failure")) })).rejects.toThrow("forced failure");
      expect(await db.remittanceRow.count({ where: { scheduleId: schedule.id, reversedAt: { not: null } } })).toBe(0);
      expect((await db.correctionBatch.findUniqueOrThrow({ where: { id: correction.id } })).status).toBe("PREPARED");

      await verifyCorrection(db, finance, correction.id);
      const after = await db.remittanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
      expect(after.adviceId).toBe(corrected.id);
      expect((await db.sourceAdvice.findUniqueOrThrow({ where: { id: schedule.adviceId as string } })).status).toBe("SUPERSEDED");
      expect((await db.sourceAdvice.findUniqueOrThrow({ where: { id: corrected.id } })).status).toBe("USED");
      const credit = await db.ledgerEvent.findMany({ where: { moduleEntityType: "Member", moduleEntityId: b.id, eventType: "DEPOSIT_CREDITED" } });
      expect(credit.reduce((t, e) => t + e.depositDelta, 0n)).toBe(0n); // credited, then reversed
      expect(credit).toHaveLength(2);
      const live = await db.remittanceRow.findMany({ where: { scheduleId: schedule.id, reversedAt: null } });
      expect(live.map((r) => r.amount)).toEqual([5_500_000n]);
    });
  });
});

