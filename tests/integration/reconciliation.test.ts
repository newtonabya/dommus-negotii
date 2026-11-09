/**
 * Monthly reconciliation, exceptions and month close (PRD F11) against the
 * test database. Runs are scoped to this test's own account and source, since
 * the test database holds every other test's data.
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
import { storeEvidenceBytes } from "@/evidence/service";
import { LocalEvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { createBankAccount } from "@/modules/credit/banking/bank-accounts";
import { matchVoucher, recordBankLineEntry, recordLodgement, verifyBankLineEntry, verifyLodgement } from "@/modules/credit/banking/matching";
import { commitOpeningBalance, importStatement, uploadOpeningBalance } from "@/modules/credit/banking/statements";
import { toDbDate } from "@/modules/credit/loans/common";
import { placeholderEmail } from "@/modules/credit/members/rules";
import { closeMonth, monthLedgerTotals, priorPeriodAdjustments } from "@/modules/credit/reconciliation/close";
import { monthBounds, ReconciliationError, runReconciliation } from "@/modules/credit/reconciliation/reconciliation";
import { commitSchedule, previewSchedule } from "@/modules/credit/remittance/schedules";
import { uploadSourceAdvice } from "@/modules/credit/remittance/source-advice";
import { closeException, reviewException } from "@/shell/exceptions/exceptions";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(300_000);

const pdf = () => ({ filename: "doc.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) });
const who = (p: string) => ({ id: `${p}-${randomUUID()}`, ipAddress: "127.0.0.1" });

describeDb("reconciliation and month close (F11)", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const admin = who("admin");
  const finance = who("fm");
  const treasurer = who("tr");
  const cashier = who("cashier");
  const gmd = who("gmd");

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
    dir = await mkdtemp(path.join(tmpdir(), "recon-"));
    store = new LocalEvidenceStore(dir, "test-secret");
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("[AT-h][AT-k] holds both equations to the kobo, raises a shortfall without touching loans, and lets only the GMD close a reviewed exception", async () => {
    // Two months ago, so its statements (to month end + 3 days) are in the past.
    const today = todayInLagos();
    const lastMonthEnd = addDays(localDate(`${today.slice(0, 7)}-01`), -1);
    const month = addDays(localDate(`${lastMonthEnd.slice(0, 7)}-01`), -1).slice(0, 7);
    const { start, end } = monthBounds(month);
    const d = (n: number) => localDate(`${month}-${String(n).padStart(2, "0")}`);

    const acc = await createBankAccount(db, admin, { bankName: "Recon Bank", branch: "", accountName: "MOAUM", accountNumber: String(randomInt(1e9, 9.99e9)).slice(0, 10) });
    const opening = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: addDays(start, -1), amount: "1,000,000" }, pdf());
    await commitOpeningBalance(db, finance, opening.id);
    const source = await db.remittanceSource.create({ data: { code: `REC-${randomInt(1e5, 9e5)}`, name: "Payroll", createdById: "test" } });
    const scope = { bankAccountIds: [acc.id], sourceIds: [source.id] };
    const member = async (name: string) => {
      const userId = randomBytes(16).toString("hex");
      const phone = `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
      await db.user.create({ data: { id: userId, name, email: placeholderEmail(phone), phoneNumber: phone } });
      return db.member.create({ data: { userId, fullName: name, phone, address: "Makurdi", moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`, nextOfKinName: "K", nextOfKinPhone: "+2347010000000", status: "ACTIVE", remittanceSourceId: source.id } });
    };
    const x = await member("Ochai X");
    const y = await member("Aondo Y");
    const loan = await db.loan.create({
      data: { loanAccountNo: `CSS-R${randomInt(1e7, 9e7)}`, memberId: x.id, status: "ACTIVE", purpose: "Test", amountRequested: 100_000_000n, tenureRequested: 10, amountApproved: 100_000_000n, tenureApproved: 10, rateBps: 750, d0: toDbDate(addDays(start, -20)), createdById: "test" },
    });

    // Disbursement V1 (on the statement) and refund V2 (paid, not on the statement yet).
    const voucher = async (amount: bigint, valueDate: string, ref: string, type: "DISBURSEMENT" | "REFUND") => {
      const v = await db.voucher.create({
        data: { type, status: "VERIFIED", amount, valueDate: toDbDate(localDate(valueDate)), bankAccountId: acc.id, transferRef: ref, beneficiaryName: "B", beneficiaryBank: "GTB", beneficiaryAccountNo: "0123456789", evidenceId: randomUUID(), preparedById: "c", verifiedById: "f" },
      });
      await postEvent(db, {
        occurredAt: toDbDate(localDate(valueDate)),
        moduleCode: "CREDIT",
        eventType: "CASH_OUT",
        source: type === "DISBURSEMENT" ? "DISBURSEMENT_VOUCHER" : "REFUND_VOUCHER",
        evidenceRefs: [v.evidenceId],
        portalUserId: "f",
        moduleEntityType: type === "DISBURSEMENT" ? "Loan" : "Refund",
        moduleEntityId: randomUUID(),
        bankAccountId: acc.id,
        cashAmount: amount,
        principalAmount: type === "DISBURSEMENT" ? amount : 0n,
        uniquenessKey: `TEST:RECON:${v.id}`,
        metadata: { voucherId: v.id },
      });
      return v;
    };
    const v1 = await voucher(25_000_000n, d(5), "TRF-V1", "DISBURSEMENT");
    await voucher(4_000_000n, d(28), "TRF-V2", "REFUND");

    // ₦500,000 schedule; lodgements declared: ₦480,000 (will verify) and ₦15,000 (never seen at the bank).
    const ref = `ADV-${randomInt(1e6, 9e6)}`;
    await uploadSourceAdvice(
      db,
      store,
      finance,
      { remittanceSource: source.code, monthCovered: month, adviceReference: ref, controlTotal: "500000", rowCount: "2" },
      { filename: "a.csv", bytes: new TextEncoder().encode(`member_moaum_id,member_name,amount\n${x.moaumIdNumber},X,300000\n${y.moaumIdNumber},Y,200000`) },
      pdf(),
    );
    const wb = new ExcelJS.Workbook();
    const rows = wb.addWorksheet("Rows");
    rows.addRow(["row_type", "member_moaum_id", "member_name", "loan_account_no", "amount_paid", "payment_date"]);
    rows.addRow(["PAYROLL", x.moaumIdNumber, "X", "", "300000", d(20)]);
    rows.addRow(["PAYROLL", y.moaumIdNumber, "Y", "", "200000", d(20)]);
    const lodge = wb.addWorksheet("Lodgements");
    lodge.addRow(["bank_account", "deposit_date", "reference", "amount", "depositor", "note"]);
    lodge.addRow([acc.accountNumber, d(21), "SLIP-A", "480000", "Payroll", ""]);
    lodge.addRow([acc.accountNumber, d(22), "SLIP-B", "15000", "Payroll", ""]);
    const preview = await previewSchedule(
      db,
      store,
      treasurer,
      { scheduleReference: `SCH-${randomInt(1e6, 9e6)}`, remittanceSource: source.code, monthCovered: month, scheduleType: "REGULAR", adviceReference: ref, submittedBy: "Payroll", controlTotal: "500000", rowCount: "2" },
      { filename: `s-${randomUUID()}.xlsx`, bytes: new Uint8Array(await wb.xlsx.writeBuffer()) },
    );
    expect(preview.ok).toBe(true);
    const { scheduleId } = await commitSchedule(db, treasurer, preview.batchId);

    // Not before the statements cover the month plus 3 days.
    await expect(runReconciliation(db, finance, month, today, scope)).rejects.toBeInstanceOf(ReconciliationError);

    const after = addDays(end, 2);
    const csv = [
      `STATEMENT ${acc.accountNumber}`,
      "transaction_date,reference,narration,debit,credit",
      `${d(5)},TRF-V1,LOAN DISBURSEMENT,250000.00,`,
      `${d(21)},SLIP-A,PAYROLL LODGEMENT,,480000.00`,
      `${d(24)},,UNKNOWN DEPOSIT,,10000.00`,
      `${d(27)},SMSCHG,SMS CHARGES,52.50,`,
      `${after},,NEXT MONTH DEPOSIT,,7000.00`,
    ].join("\n");
    await importStatement(db, store, finance, { bankAccountId: acc.id, periodFrom: start, periodTo: addDays(end, 3), openingBalance: "1,000,000", closingBalance: "1,246,947.50" }, { filename: `st-${randomUUID()}.csv`, bytes: new TextEncoder().encode(csv) });
    const lines = await db.bankStatementLine.findMany({ where: { bankAccountId: acc.id } });
    const line = (n: string) => lines.find((l) => l.narration === n)!;
    const slipA = await db.lodgement.findFirstOrThrow({ where: { scheduleId, reference: "SLIP-A" } });
    await verifyLodgement(db, finance, line("PAYROLL LODGEMENT").id, slipA.id);
    await recordLodgement(db, cashier, slipA.id);
    await matchVoucher(db, finance, line("LOAN DISBURSEMENT").id, v1.id);
    const charge = await recordBankLineEntry(db, cashier, line("SMS CHARGES").id, "BANK_CHARGE", "");
    await verifyBankLineEntry(db, finance, charge.id);

    const loanEventsBefore = await db.ledgerEvent.count({ where: { moduleEntityType: "Loan", moduleEntityId: loan.id } });
    const { results } = await runReconciliation(db, finance, month, today, scope);

    // [AT-k] Equation (1) to the kobo, with every reconciling item listed.
    const a = results.accounts[0]!;
    expect(a.bank).toBe(123_994_750n);
    expect(a.ledger).toBe(118_994_750n);
    expect(a.residual).toBe(0n);
    expect(a.items.map((i) => [i.kind, i.amount]).sort()).toEqual([
      ["RECORDED_DEBIT_NOT_ON_STATEMENT", 4_000_000n],
      ["UNAPPLIED_CREDIT", 1_000_000n],
    ]);
    // Equation (2).
    expect(results.trackA).toMatchObject({ recorded: 50_000_000n, verified: 48_000_000n, notYetPaid: 2_000_000n, excess: 0n, holds: true });

    // [AT-h] ₦20,000 shortfall against the source; no member repayment reversed.
    const shortfall = await db.exceptionRecord.findUniqueOrThrow({ where: { dedupeKey: `SHORTFALL:${scheduleId}` } });
    expect(shortfall).toMatchObject({ type: "SHORTFALL", amount: 2_000_000n, status: "OPEN" });
    expect(await db.ledgerEvent.count({ where: { moduleEntityType: "Loan", moduleEntityId: loan.id } })).toBe(loanEventsBefore);
    expect(await db.ledgerEvent.count({ where: { moduleEntityType: "Loan", moduleEntityId: loan.id, reversesEventId: { not: null } } })).toBe(0);
    const types = (await db.exceptionRecord.findMany({ where: { dedupeKey: { in: [`IN_BANK_NOT_IN_SYSTEM:line:${line("UNKNOWN DEPOSIT").id}`, `IN_SYSTEM_NOT_IN_BANK:lodgement:${(await db.lodgement.findFirstOrThrow({ where: { scheduleId, reference: "SLIP-B" } })).id}`] } } })).map((e) => e.type);
    expect(types.sort()).toEqual(["IN_BANK_NOT_IN_SYSTEM", "IN_SYSTEM_NOT_IN_BANK"]);
    expect(await db.exceptionRecord.count({ where: { dedupeKey: `LEDGER_BANK_DIFFERENCE:${acc.id}:${month}` } })).toBe(0);

    // Only the GMD closes, only after review, only with evidence and a reason; the ledger never changes.
    const ledgerBefore = await db.ledgerEvent.count();
    const proof = await storeEvidenceBytes(db, store, gmd, "bursary-letter.pdf", pdf().bytes);
    await expect(closeException(db, gmd, shortfall.id, "Bursary paid the balance late", proof.evidenceId)).rejects.toThrow(/reviewed/);
    await reviewException(db, finance, shortfall.id, "Bursary confirms ₦20,000 was paid into the wrong account", null);
    await expect(closeException(db, gmd, shortfall.id, "short", proof.evidenceId)).rejects.toThrow(/at least 10/);
    await expect(closeException(db, gmd, shortfall.id, "Confirmed by the bursary letter", null)).rejects.toThrow(/evidence/);
    await closeException(db, gmd, shortfall.id, "Confirmed by the bursary letter", proof.evidenceId);
    expect((await db.exceptionRecord.findUniqueOrThrow({ where: { id: shortfall.id } })).status).toBe("CLOSED");
    expect(await db.ledgerEvent.count()).toBe(ledgerBefore);
  });

  it("[AT-t] keeps a closed month's snapshot as it was and shows a later backdated posting as a prior-period adjustment", async () => {
    const year = randomInt(3000, 3900);
    const month = `${year}-06`;
    const evidence = [randomUUID()];
    const post = (key: string, amount: bigint) =>
      postEvent(db, {
        occurredAt: toDbDate(localDate(`${month}-15`)),
        moduleCode: "CREDIT",
        eventType: "INTEREST_INCOME",
        source: "REMITTANCE_SCHEDULE",
        evidenceRefs: evidence,
        portalUserId: "test",
        moduleEntityType: "Loan",
        moduleEntityId: randomUUID(),
        interestAmount: amount,
        revenueAmount: amount,
        uniquenessKey: `TEST:ATT:${year}:${key}:${randomUUID()}`,
      });
    await post("before", 500_000n);
    const totalsAtClose = await monthLedgerTotals(db, month);
    // Simulate the close (the real one needs every earlier month closed first).
    const run = await db.reconciliationRun.create({ data: { month, runById: finance.id, results: {} } });
    await db.periodClose.create({ data: { month, runId: run.id, closedById: finance.id, snapshots: [], ledgerTotals: totalsAtClose } });
    await new Promise((r) => setTimeout(r, 20));
    const late = await post("backdated", 70_000n);

    const stored = await db.periodClose.findUniqueOrThrow({ where: { month } });
    expect(stored.ledgerTotals).toEqual(totalsAtClose);
    expect((await monthLedgerTotals(db, month)).INTEREST_INCOME).not.toEqual(totalsAtClose.INTEREST_INCOME);
    const adjustments = await priorPeriodAdjustments(db);
    expect(adjustments.filter((a) => a.closedMonth === month).map((a) => a.event.id)).toEqual([late.event.id]);

    // Months close in order and never reopen.
    await expect(closeMonth(db, store, finance, month, localDate(`${year}-12-31`))).rejects.toThrow(/already closed/);
    await expect(closeMonth(db, store, finance, `${year}-09`, localDate(`${year}-12-31`))).rejects.toThrow(/Months close in order/);
  });
});
