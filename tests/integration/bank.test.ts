/**
 * Bank accounts and statements, Track B (PRD F10) against the test database:
 * go-live opening balances, statement import through a saved column mapping,
 * continuity and overlapping statements.
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
import {
  ageingReport,
  matchVoucher,
  proposeLodgements,
  proposeVouchers,
  recordBankLineEntry,
  recordLodgement,
  tagDirectPayment,
  verifyBankLineEntry,
  verifyLodgement,
} from "@/modules/credit/banking/matching";
import { commitSchedule, loadSchedulePreview, previewSchedule } from "@/modules/credit/remittance/schedules";
import { uploadSourceAdvice } from "@/modules/credit/remittance/source-advice";
import { ForbiddenError } from "@/shell/rbac/permissions";
import { BankError, commitOpeningBalance, importStatement, rejectOpeningBalance, saveMapping, uploadOpeningBalance } from "@/modules/credit/banking/statements";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(240_000);

const pdf = () => ({ filename: "statement.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) });
const csv = (lines: string[]) => ({ filename: `statement-${randomUUID()}.csv`, bytes: new TextEncoder().encode(lines.join("\r\n")) });

describeDb("bank statements (F10)", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const admin = { id: `admin-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const finance = { id: `fm-${randomUUID()}`, ipAddress: "127.0.0.1" };

  async function account() {
    return createBankAccount(db, admin, { bankName: "Test Bank", branch: "", accountName: "MOAUM", accountNumber: String(randomInt(1e9, 9.99e9)).slice(0, 10) });
  }

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
    dir = await mkdtemp(path.join(tmpdir(), "bank-"));
    store = new LocalEvidenceStore(dir, "test-secret");
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("takes a go-live opening balance from Admin and posts it only when someone else commits it", async () => {
    const acc = await account();
    const first = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "1,000,000.00" }, pdf());
    await expect(uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "5" }, pdf())).rejects.toThrow(/already has an opening balance/);
    await expect(commitOpeningBalance(db, admin, first.id)).rejects.toThrow(/Someone other than the uploader/);
    await rejectOpeningBalance(db, finance, first.id, "Wrong statement attached");

    const opening = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "1,200,000.00" }, pdf());
    await commitOpeningBalance(db, finance, opening.id);
    const event = await db.ledgerEvent.findFirstOrThrow({ where: { moduleEntityType: "BankAccount", moduleEntityId: acc.id, eventType: "OPENING_BALANCE" } });
    expect(event).toMatchObject({ cashAmount: 120_000_000n, bankAccountId: acc.id, source: "LEGACY_IMPORT", portalUserId: finance.id });
    await expect(commitOpeningBalance(db, finance, opening.id)).rejects.toThrow(/already been decided/);
  });

  it("imports statements through the account's column mapping, checks continuity, and skips lines it already has", async () => {
    const acc = await account();
    await expect(importStatement(db, store, finance, { bankAccountId: acc.id, periodFrom: "2026-01-01", periodTo: "2026-01-31", openingBalance: "0", closingBalance: "0" }, csv(["x"]))).rejects.toThrow(
      /Commit this account's go-live opening balance/,
    );
    const opening = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "500,000" }, pdf());
    await commitOpeningBalance(db, finance, opening.id);

    // The bank's own export: a title line, its own headers, day-first dates.
    await saveMapping(db, finance, acc.id, {
      fields: { transaction_date: "Trans Date", narration: "Narration", reference: "Ref", debit: "Withdrawals", credit: "Lodgements", balance: "Balance" },
      dateFormat: "DMY",
    });
    const header = "Trans Date,Ref,Narration,Withdrawals,Lodgements,Balance";
    const jan = csv([
      `TEST BANK STATEMENT JANUARY 2026 ${acc.accountNumber}`,
      header,
      "02/01/2026,TRF001,PAYROLL OCT,,77500.00,577500.00",
      "15/01/2026,CHG,SMS ALERT CHARGES,52.50,,577447.50",
      "28/01/2026,TRF002,TRANSFER FROM ADA OKEKE,,20000.00,597447.50",
    ]);
    const input = { bankAccountId: acc.id, periodFrom: "2026-01-01", periodTo: "2026-01-31", openingBalance: "500,000.00", closingBalance: "597,447.50" };

    await expect(importStatement(db, store, finance, { ...input, openingBalance: "499,000", closingBalance: "596,447.50" }, jan)).rejects.toThrow(/doesn't continue the go-live opening balance of ₦500,000.00/);
    await expect(importStatement(db, store, finance, { ...input, closingBalance: "600,000" }, jan)).rejects.toMatchObject({ details: [expect.stringMatching(/not the closing balance/)] });
    await expect(importStatement(db, store, finance, input, csv([header, "02/13/2026,X,Y,,1.00,"]))).rejects.toBeInstanceOf(BankError);

    const first = await importStatement(db, store, finance, input, jan);
    expect(first).toMatchObject({ lineCount: 3, skippedCount: 0 });
    const lines = await db.bankStatementLine.findMany({ where: { statementId: first.id }, orderBy: { transactionDate: "asc" } });
    expect(lines.map((l) => [l.transactionDate.toISOString().slice(0, 10), l.direction, l.amount])).toEqual([
      ["2026-01-02", "CREDIT", 7_750_000n],
      ["2026-01-15", "DEBIT", 5_250n],
      ["2026-01-28", "CREDIT", 2_000_000n],
    ]);

    // February continues January; the overlapping 28 January line is not duplicated.
    const feb = csv([`STATEMENT ${acc.accountNumber}`, header, "28/01/2026,TRF002,TRANSFER FROM ADA OKEKE,,20000.00,597447.50", "03-Feb-2026,TRF003,PAYROLL NOV,,80000.00,677447.50"]);
    await expect(importStatement(db, store, finance, { ...input, periodFrom: "2026-01-28", periodTo: "2026-02-28", openingBalance: "500,000", closingBalance: "600,000" }, feb)).rejects.toThrow(
      /doesn't continue the previous statement's closing balance/,
    );
    const second = await importStatement(
      db,
      store,
      finance,
      { ...input, periodFrom: "2026-01-28", periodTo: "2026-02-28", openingBalance: "577,447.50", closingBalance: "677,447.50" },
      feb,
    );
    expect(second).toMatchObject({ lineCount: 1, skippedCount: 1 });
    expect(await db.bankStatementLine.count({ where: { bankAccountId: acc.id } })).toBe(4);
  });

  it("[AT-f][AT-g] matches credits to lodgements and tagged direct payments, records only verified ones, and ages what's left", async () => {
    const cashier = { id: `cashier-${randomUUID()}`, ipAddress: "127.0.0.1" };
    const treasurer = { id: `tr-${randomUUID()}`, ipAddress: "127.0.0.1" };
    const today = todayInLagos();
    const lastMonthEnd = addDays(localDate(`${today.slice(0, 7)}-01`), -1);
    const month = lastMonthEnd.slice(0, 7);
    const d = (n: number) => `${month}-${String(n).padStart(2, "0")}`;
    const dmy = (n: number) => `${String(n).padStart(2, "0")}/${month.slice(5)}/${month.slice(0, 4)}`;

    const acc = await account();
    const opening = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: addDays(localDate(d(1)), -1), amount: "100,000" }, pdf());
    await commitOpeningBalance(db, finance, opening.id);
    await saveMapping(db, finance, acc.id, { fields: {}, dateFormat: "DMY" });
    const source = await db.remittanceSource.create({ data: { code: `PAY-${randomInt(1e5, 9e5)}`, name: "Payroll", createdById: "test" } });
    const member = async () => {
      const userId = randomBytes(16).toString("hex");
      const p = `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
      await db.user.create({ data: { id: userId, name: "M", email: `${userId}@members.dommus.invalid`, phoneNumber: p } });
      return db.member.create({
        data: { userId, fullName: "Member", phone: p, address: "Makurdi", moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`, nextOfKinName: "K", nextOfKinPhone: "+2347010000000", status: "ACTIVE" },
      });
    };
    const payroll = await member();
    const direct = await member();

    // Statement: payroll lodgement, a direct payment, an unknown credit, a bank charge and a disbursement.
    const voucher = await db.voucher.create({
      data: {
        type: "DISBURSEMENT",
        status: "VERIFIED",
        amount: 30_000_000n,
        valueDate: new Date(`${d(20)}T00:00:00Z`),
        bankAccountId: acc.id,
        transferRef: "TRF-9",
        beneficiaryName: "B",
        beneficiaryBank: "GTB",
        beneficiaryAccountNo: "0123456789",
        evidenceId: randomUUID(),
        preparedById: "c",
        verifiedById: "f",
      },
    });
    const statement = await importStatement(
      db,
      store,
      finance,
      { bankAccountId: acc.id, periodFrom: d(1), periodTo: lastMonthEnd, openingBalance: "100,000", closingBalance: "797,447.50" },
      csv([
        `STATEMENT ${acc.accountNumber}`,
        "transaction_date,reference,narration,debit,credit,balance",
        `${dmy(24)},SLIP-1,PAYROLL LODGEMENT,,77500,177500`,
        `${dmy(25)},TRF-77,TRANSFER FROM MEMBER,,20000,197500`,
        `${dmy(26)},,UNKNOWN DEPOSIT,,1000000,1197500`,
        `${dmy(27)},CHG,SMS CHARGES,52.50,,1197447.50`,
        `${dmy(21)},TRF-9,LOAN DISBURSEMENT,300000,,897447.50`,
        `${dmy(28)},,ANOTHER UNKNOWN,,100000,997447.50`,
        `${dmy(28)},,REVERSAL,200000,,797447.50`,
      ]),
    );
    const lines = await db.bankStatementLine.findMany({ where: { statementId: statement.id } });
    const line = (narration: string) => lines.find((l) => l.narration === narration)!;

    // Finance Manager tags the direct payment to its member.
    const tag = await tagDirectPayment(db, store, finance, line("TRANSFER FROM MEMBER").id, { member: direct.memberNo, note: "Member's own transfer" }, null);
    expect(tag.reference).toMatch(/^DP-/);

    // Treasurer posts the month's schedule: a payroll row with its lodgement line, and the DIRECT row.
    const adviceRef = `ADV-${randomInt(1e6, 9e6)}`;
    await uploadSourceAdvice(
      db,
      store,
      finance,
      { remittanceSource: source.code, monthCovered: month, adviceReference: adviceRef, controlTotal: "77500", rowCount: "1" },
      { filename: "a.csv", bytes: new TextEncoder().encode(`member_moaum_id,member_name,amount\n${payroll.moaumIdNumber},P,77500`) },
      pdf(),
    );
    const wb = new ExcelJS.Workbook();
    const rows = wb.addWorksheet("Rows");
    rows.addRow(["row_type", "member_moaum_id", "member_name", "loan_account_no", "amount_paid", "payment_date", "bank_credit_ref"]);
    rows.addRow(["PAYROLL", payroll.moaumIdNumber, "P", "", "77500", d(24), ""]);
    rows.addRow(["DIRECT", direct.moaumIdNumber, "D", "", "20000", d(25), tag.reference]);
    const lodge = wb.addWorksheet("Lodgements");
    lodge.addRow(["bank_account", "deposit_date", "reference", "amount", "depositor", "note"]);
    lodge.addRow([acc.accountNumber, d(23), "SLIP-1", "77500", "Payroll office", ""]);
    const header = { scheduleReference: `SCH-${randomInt(1e6, 9e6)}`, remittanceSource: source.code, monthCovered: month, scheduleType: "REGULAR", adviceReference: adviceRef, submittedBy: "Payroll", controlTotal: "97500", rowCount: "2" };
    const preview = await previewSchedule(db, store, treasurer, header, { filename: `s-${randomUUID()}.xlsx`, bytes: new Uint8Array(await wb.xlsx.writeBuffer()) });
    expect((await loadSchedulePreview(db, preview.batchId))?.stored.batchErrors).toEqual([]);
    expect(preview.ok).toBe(true);
    const { scheduleId } = await commitSchedule(db, treasurer, preview.batchId);

    const lodgements = await db.lodgement.findMany({ where: { scheduleId }, orderBy: { amount: "desc" } });
    expect(lodgements.map((l) => [l.amount, l.status])).toEqual([
      [7_750_000n, "UNVERIFIED"],
      [2_000_000n, "BANK_VERIFIED"],
    ]);
    const [payrollLodgement, directLodgement] = lodgements;

    // [AT-f] The Cashier can't record a lodgement the bank hasn't confirmed: 403 and an audit entry.
    await expect(recordLodgement(db, cashier, payrollLodgement!.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.auditLog.count({ where: { action: "lodgement.record.blocked", entityId: payrollLodgement!.id, userId: cashier.id } })).toBe(1);

    // The system proposes, the Finance Manager confirms.
    const credit = line("PAYROLL LODGEMENT");
    expect((await proposeLodgements(db, credit)).map((l) => l.id)).toEqual([payrollLodgement!.id]);
    await expect(verifyLodgement(db, finance, line("UNKNOWN DEPOSIT").id, payrollLodgement!.id)).rejects.toThrow(/Amounts differ/);
    await verifyLodgement(db, finance, credit.id, payrollLodgement!.id);
    await recordLodgement(db, cashier, payrollLodgement!.id);
    await recordLodgement(db, cashier, directLodgement!.id);
    await expect(recordLodgement(db, cashier, payrollLodgement!.id)).rejects.toThrow(/already been recorded/);
    const cashIn = await db.ledgerEvent.findMany({ where: { eventType: "CASH_IN", bankAccountId: acc.id, moduleEntityType: "Lodgement" } });
    expect(cashIn.map((e) => e.cashAmount).sort()).toEqual([2_000_000n, 7_750_000n]);

    // Bank charge: Cashier records, someone else verifies; never revenue.
    const charge = await recordBankLineEntry(db, cashier, line("SMS CHARGES").id, "BANK_CHARGE", "");
    await expect(recordBankLineEntry(db, cashier, line("UNKNOWN DEPOSIT").id, "BANK_CHARGE", "")).rejects.toThrow(/bank charge is a debit/);
    await expect(verifyBankLineEntry(db, cashier, charge.id)).rejects.toThrow(/Someone else/);
    await verifyBankLineEntry(db, finance, charge.id);
    const out = await db.ledgerEvent.findFirstOrThrow({ where: { moduleEntityType: "BankLineEntry", moduleEntityId: charge.id } });
    expect(out).toMatchObject({ eventType: "CASH_OUT", cashAmount: 5_250n, revenueAmount: 0n, source: "BANK_STATEMENT", bankAccountId: acc.id });
    expect(out.metadata).toMatchObject({ category: "BANK_CHARGE" });

    // Debit matched to its verified voucher.
    const debit = line("LOAN DISBURSEMENT");
    expect((await proposeVouchers(db, debit)).map((v) => v.id)).toEqual([voucher.id]);
    await matchVoucher(db, finance, debit.id, voucher.id);

    // [AT-g] Credits with no lodgement and no tag are Unapplied Bank Credits, aged.
    const report = await ageingReport(db, today);
    const unapplied = report.unappliedCredits.rows.filter((r) => r.bankAccountId === acc.id);
    expect(unapplied.map((r) => r.amount).sort()).toEqual([10_000_000n, 100_000_000n]);
    expect(unapplied.every((r) => r.days >= 0 && ["0–30", "31–60"].includes(r.bucket))).toBe(true);
    expect(report.unverifiedLodgements.rows.some((r) => r.id === payrollLodgement!.id)).toBe(false);
  });
});
