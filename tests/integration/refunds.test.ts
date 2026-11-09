/**
 * Overpayment Credit refunds and reclassification (PRD F12) against the test
 * database. Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { addDays, localDate, todayInLagos } from "@/lib/dates";
import { kobo } from "@/lib/money";
import { LocalEvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { createBankAccount } from "@/modules/credit/banking/bank-accounts";
import { computeLoanState } from "@/modules/credit/domain/recompute";
import { loanTerms, toDbDate } from "@/modules/credit/loans/common";
import { overpaymentCredit } from "@/modules/credit/loans/queries";
import { loanLiveState } from "@/modules/credit/loans/repayments";
import { placeholderEmail } from "@/modules/credit/members/rules";
import { prepareReclassification, returnReclassification, verifyReclassification } from "@/modules/credit/refunds/reclassifications";
import {
  approveRefund,
  captureRefundRequest,
  creditMovements,
  prepareRefundVoucher,
  rejectRefund,
  requestRefund,
  returnRefundVoucher,
  verifyRefundVoucher,
} from "@/modules/credit/refunds/refunds";
import { commitSchedule, previewSchedule } from "@/modules/credit/remittance/schedules";
import { uploadSourceAdvice } from "@/modules/credit/remittance/source-advice";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(240_000);

const pdf = () => ({ filename: "doc.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) });
const actor = (p: string) => ({ id: `${p}-${randomUUID()}`, ipAddress: "127.0.0.1" });
const bank = { beneficiaryName: "Account Holder", beneficiaryBank: "GTBank", beneficiaryAccountNo: "0123456789" };

describeDb("refunds and reclassification (F12)", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  let bankAccountId: string;
  const officer = actor("lo");
  const management = actor("mgmt");
  const cashier = actor("cashier");
  const finance = actor("fm");
  const treasurer = actor("tr");

  async function member() {
    const userId = randomBytes(16).toString("hex");
    const phone = `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
    await db.user.create({ data: { id: userId, name: "Member", email: placeholderEmail(phone), phoneNumber: phone } });
    const m = await db.member.create({
      data: { userId, fullName: "Ngozi Demo", phone, address: "Makurdi", moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`, nextOfKinName: "K", nextOfKinPhone: "+2347010000000", status: "ACTIVE" },
    });
    return { member: m, user: { id: userId, ipAddress: "127.0.0.1" } };
  }
  async function credit(memberId: string, amount: bigint) {
    await postEvent(db, {
      occurredAt: new Date(),
      moduleCode: "CREDIT",
      eventType: "DEPOSIT_CREDITED",
      source: "REMITTANCE_SCHEDULE",
      evidenceRefs: [randomUUID()],
      portalUserId: "test",
      moduleEntityType: "Member",
      moduleEntityId: memberId,
      depositDelta: amount,
      uniquenessKey: `TEST:CREDIT:${randomUUID()}`,
      metadata: { reason: "No active loan" },
    });
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
    dir = await mkdtemp(path.join(tmpdir(), "refunds-"));
    store = new LocalEvidenceStore(dir, "test-secret");
    bankAccountId = (await createBankAccount(db, actor("admin"), { bankName: "Test Bank", branch: "", accountName: "MOAUM", accountNumber: String(randomInt(1e9, 9.99e9)).slice(0, 10) })).id;
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("refunds Overpayment Credit through request, approval, voucher and verification, each by someone different", async () => {
    const { member: m, user } = await member();
    await credit(m.id, 5_000_000n);

    await expect(requestRefund(db, user, { amount: "60,000", ...bank })).rejects.toThrow(/available to refund is ₦50,000.00/);
    const refund = await requestRefund(db, user, { amount: "30,000", ...bank });
    await expect(requestRefund(db, user, { amount: "1,000", ...bank })).rejects.toThrow(/already in progress/);
    await expect(captureRefundRequest(db, store, officer, m.memberNo, { amount: "1,000", ...bank }, pdf())).rejects.toThrow(/already in progress/);

    await approveRefund(db, management, refund.id, "Credit confirmed");
    const voucher = await prepareRefundVoucher(db, store, cashier, refund.id, { bankAccountId, valueDate: todayInLagos(), transferRef: "TRF-R-1" }, pdf());
    await expect(verifyRefundVoucher(db, cashier, voucher.id)).rejects.toThrow(/Someone else must verify/);
    await returnRefundVoucher(db, finance, voucher.id, "Wrong transfer slip attached");
    const second = await prepareRefundVoucher(db, store, cashier, refund.id, { bankAccountId, valueDate: todayInLagos(), transferRef: "TRF-R-2" }, pdf());
    await verifyRefundVoucher(db, finance, second.id);

    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("PAID");
    const cashOut = await db.ledgerEvent.findFirstOrThrow({ where: { moduleEntityType: "Refund", moduleEntityId: refund.id } });
    expect(cashOut).toMatchObject({ eventType: "CASH_OUT", source: "REFUND_VOUCHER", cashAmount: 3_000_000n, bankAccountId, revenueAmount: 0n });
    expect(await overpaymentCredit(db, m.id)).toBe(2_000_000n);
    const moves = await creditMovements(db, m.id);
    expect(moves.map((x) => [x.change, x.balance])).toEqual([
      [5_000_000n, 5_000_000n],
      [-3_000_000n, 2_000_000n],
    ]);

    // A rejected request never touches the credit.
    await expect(requestRefund(db, user, { amount: "25,000", ...bank })).rejects.toThrow(/available to refund is ₦20,000.00/);
    const another = await captureRefundRequest(db, store, officer, m.memberNo, { amount: "20,000", ...bank }, pdf());
    await expect(rejectRefund(db, management, another.id, "no")).rejects.toThrow(/Say why/);
    await rejectRefund(db, management, another.id, "Member asked to keep the credit");
    expect(await overpaymentCredit(db, m.id)).toBe(2_000_000n);
  });

  it("moves a prepayment to Overpayment Credit so the loan is as if it was never paid, before the next regular schedule", async () => {
    const today = todayInLagos();
    const lastMonthEnd = addDays(localDate(`${today.slice(0, 7)}-01`), -1);
    const month = lastMonthEnd.slice(0, 7);
    const payDay = localDate(`${month}-25`);
    const d0 = addDays(payDay, -10);
    const { member: m } = await member();
    const source = await db.remittanceSource.create({ data: { code: `PAY-${randomInt(1e5, 9e5)}`, name: "Payroll", createdById: "test" } });
    const loan = await db.loan.create({
      data: { loanAccountNo: `CSS-T${randomInt(1e7, 9e7)}`, memberId: m.id, status: "ACTIVE", purpose: "Test", amountRequested: 10_000_000n, tenureRequested: 10, amountApproved: 10_000_000n, tenureApproved: 10, rateBps: 750, d0: toDbDate(d0), createdById: "test" },
    });
    // First instalment is ₦17,500; the member paid ₦47,500, so ₦30,000 went to principal ahead of time.
    const ref = `ADV-${randomInt(1e6, 9e6)}`;
    await uploadSourceAdvice(db, store, finance, { remittanceSource: source.code, monthCovered: month, adviceReference: ref, controlTotal: "47500", rowCount: "1" }, { filename: "a.csv", bytes: new TextEncoder().encode(`member_moaum_id,member_name,amount\n${m.moaumIdNumber},N,47500`) }, pdf());
    const csv = `row_type,member_moaum_id,member_name,loan_account_no,amount_paid,payment_date\nPAYROLL,${m.moaumIdNumber},N,,47500,${payDay}\n`;
    const preview = await previewSchedule(db, store, treasurer, { scheduleReference: `SCH-${randomInt(1e6, 9e6)}`, remittanceSource: source.code, monthCovered: month, scheduleType: "REGULAR", adviceReference: ref, submittedBy: "Payroll", controlTotal: "47500", rowCount: "1" }, { filename: `s-${randomUUID()}.csv`, bytes: new TextEncoder().encode(csv) });
    expect(preview.ok).toBe(true);
    const { scheduleId } = await commitSchedule(db, treasurer, preview.batchId);
    const row = await db.remittanceRow.findFirstOrThrow({ where: { scheduleId } });

    const input = { rowId: row.id, amount: "30,000", reason: "Member asked for the extra ₦30,000 back" };
    await expect(prepareReclassification(db, store, treasurer, { ...input, amount: "50,000" }, pdf())).rejects.toThrow(/At most/);
    const first = await prepareReclassification(db, store, treasurer, input, pdf());
    await expect(verifyReclassification(db, treasurer, first.id)).rejects.toThrow(/Someone else must verify/);
    await returnReclassification(db, finance, first.id, "Attach the signed request");
    const reclass = await prepareReclassification(db, store, treasurer, input, pdf());
    await verifyReclassification(db, finance, reclass.id);

    // The loan now looks exactly as if only ₦17,500 had been paid.
    const fresh = await db.loan.findUniqueOrThrow({ where: { id: loan.id } });
    const live = await loanLiveState(db, fresh, today);
    const expected = computeLoanState(loanTerms(fresh), [{ id: row.id, date: payDay, amount: kobo(1_750_000n), order: "1" }], today);
    expect(live?.state.installments).toEqual(expected.installments);
    expect(live?.state.outstandingPrincipal).toBe(expected.outstandingPrincipal);
    expect(await overpaymentCredit(db, m.id)).toBe(3_000_000n);
    const principal = await db.ledgerEvent.findMany({ where: { moduleEntityType: "Loan", moduleEntityId: loan.id, eventType: "PRINCIPAL_RECOVERY" } });
    expect(principal.reduce((t, e) => t + e.principalAmount, 0n)).toBe(1_000_000n);

    // Once the next regular schedule for the source has posted, it's too late.
    const nextMonth = today.slice(0, 7);
    const advice = await db.sourceAdvice.create({ data: { remittanceSourceId: source.id, monthCovered: nextMonth, adviceReference: `ADV-NEXT-${randomInt(1e6, 9e6)}`, controlTotal: 1n, rowCount: 1, evidenceId: randomUUID(), status: "USED", uploadedById: "test" } });
    await db.remittanceSchedule.create({
      data: { remittanceSourceId: source.id, scheduleReference: `SCH-NEXT-${randomInt(1e6, 9e6)}`, monthCovered: nextMonth, type: "REGULAR", adviceId: advice.id, submittedBy: "Payroll", controlTotal: 1n, rowCount: 1, evidenceId: randomUUID(), checksum: "x", uploadedById: "test" },
    });
    await expect(prepareReclassification(db, store, treasurer, { ...input, amount: "1,000" }, pdf())).rejects.toThrow(/Too late/);
  });
});
