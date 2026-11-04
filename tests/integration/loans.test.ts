/**
 * Loan workflow against the test database (PRD F7): application to
 * disbursement, the roles' checks, voucher rules and the limits (AT-u).
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { bps, kobo } from "@/lib/money";
import { beginUpload, finishUpload } from "@/evidence/service";
import { LocalEvidenceStore } from "@/evidence/store";
import { createBankAccount } from "@/modules/credit/banking/bank-accounts";
import { planSchedule } from "@/modules/credit/domain/schedule";
import { cancelMemberApplication, captureAssistedApplication, saveMemberApplication, type ApplicationInput } from "@/modules/credit/loans/applications";
import { prepareDisbursementVoucher, returnDisbursementVoucher, verifyDisbursementVoucher } from "@/modules/credit/loans/disbursement";
import { exposurePanel } from "@/modules/credit/loans/queries";
import { approveLoan, declineLoan, recommendLoan, verifyLoan } from "@/modules/credit/loans/review";
import { placeholderEmail } from "@/modules/credit/members/rules";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(150_000);

const phone = () => `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
const local = (e164: string) => `0${e164.slice(4)}`;

describeDb("loan workflow", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  let bankAccountId: string;
  const actor = (role: string) => ({ id: `${role}-${randomUUID()}`, ipAddress: "127.0.0.1" });
  const officer = actor("lo");
  const management = actor("mgmt");
  const cashier = actor("cashier");
  const finance = actor("fm");
  const admin = actor("admin");

  async function newMember(withScan = true) {
    const userId = randomBytes(16).toString("hex");
    const p = phone();
    await db.user.create({ data: { id: userId, name: "Chinedu Okeke", email: placeholderEmail(p), phoneNumber: p, phoneNumberVerified: true } });
    const member = await db.member.create({
      data: {
        userId,
        fullName: "Chinedu Okeke",
        phone: p,
        address: "5 Ogiri Oko Road, Makurdi",
        moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`,
        idScanEvidenceId: withScan ? randomUUID() : null,
        nextOfKinName: "Ada Okeke",
        nextOfKinPhone: "+2347010000000",
        status: "ACTIVE",
      },
    });
    return { member, user: { id: userId, ipAddress: "127.0.0.1" } };
  }

  async function upload(userId: string, name = "form.pdf") {
    const a = { id: userId, ipAddress: null };
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]);
    const begun = await beginUpload(db, store, a, { filename: name, size: bytes.length });
    await store.putFile(`staging/${begun.uploadId}`, bytes);
    return (await finishUpload(db, store, a, begun.uploadId)).evidenceId;
  }

  const application = (over: Partial<ApplicationInput> = {}): ApplicationInput => ({
    amount: "300,000",
    tenure: 10,
    purpose: "School fees for two children",
    guarantorIsMember: false,
    guarantorName: "Terver Iorliam",
    guarantorPhone: local(phone()),
    guarantorAddress: "12 High Level, Makurdi",
    guarantorRelationship: "Colleague",
    ...over,
  });

  async function submitted(memberUser: { id: string; ipAddress: string }, over: Partial<ApplicationInput> = {}) {
    const form = await upload(memberUser.id);
    return saveMemberApplication(db, memberUser, { ...application(over), guarantorFormEvidenceId: form }, true);
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
    dir = await mkdtemp(path.join(tmpdir(), "loans-"));
    store = new LocalEvidenceStore(dir, "test-secret");
    const account = await createBankAccount(db, admin, {
      bankName: "Test Bank",
      branch: "Makurdi",
      accountName: "MOAUM Credit Super Store",
      accountNumber: String(randomInt(1e9, 9.99e9)).slice(0, 10).padStart(10, "1"),
    });
    bankAccountId = account.id;
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("takes an application through approval and disbursement to an ACTIVE loan with its binding schedule", async () => {
    const { member, user } = await newMember();
    const { loanId, loanAccountNo } = await submitted(user);
    expect(loanAccountNo).toMatch(new RegExp(`^CSS-${todayInLagos().slice(0, 4)}-\\d{5}$`));

    await verifyLoan(db, officer, loanId, "ID and guarantor form checked");
    await expect(approveLoan(db, management, loanId, { amount: "250,000", tenure: "8", comment: "" })).rejects.toThrow(/verified can.t be moved to approved/);
    await recommendLoan(db, officer, loanId, "Good repayment history");
    await expect(approveLoan(db, management, loanId, { amount: "350,000", tenure: "8", comment: "" })).rejects.toThrow(/more than the amount requested/);
    await approveLoan(db, management, loanId, { amount: "250,000", tenure: "8", comment: "Reduced to fit salary" });
    let loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan).toMatchObject({ status: "APPROVED", amountRequested: 30_000_000n, amountApproved: 25_000_000n, tenureRequested: 10, tenureApproved: 8, rateBps: 750 });

    const evidenceId = await upload(cashier.id, "transfer.pdf");
    const voucherInput = {
      bankAccountId,
      valueDate: todayInLagos(),
      transferRef: `TRF-${randomInt(1e5, 9e5)}`,
      beneficiaryName: member.fullName,
      beneficiaryBank: "GTBank",
      beneficiaryAccountNo: "0123456789",
      evidenceId,
    };
    const voucher = await prepareDisbursementVoucher(db, cashier, loanId, voucherInput);
    expect(voucher.amount).toBe(25_000_000n); // full approved amount, no deductions
    await expect(prepareDisbursementVoucher(db, cashier, loanId, voucherInput)).rejects.toThrow(/approved|already waiting/);
    await expect(verifyDisbursementVoucher(db, cashier, voucher.id)).rejects.toThrow(/someone else must verify/);

    await verifyDisbursementVoucher(db, finance, voucher.id);
    loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe("ACTIVE");
    expect(loan.d0?.toISOString().slice(0, 10)).toBe(todayInLagos());
    const expected = planSchedule({ principal: kobo(25_000_000n), tenure: 8, rate: bps(750n), d0: todayInLagos() });
    expect((loan.bindingSchedule as { total: string }).total).toBe(expected.total.toString());

    const cashOut = await db.ledgerEvent.findFirstOrThrow({ where: { moduleEntityType: "Loan", moduleEntityId: loanId, eventType: "CASH_OUT" } });
    expect(cashOut).toMatchObject({ source: "DISBURSEMENT_VOUCHER", cashAmount: 25_000_000n, principalAmount: 25_000_000n, bankAccountId, portalUserId: finance.id });

    const transitions = await db.loanTransition.findMany({ where: { loanId }, orderBy: { at: "asc" } });
    expect(transitions.map((t) => t.toStatus)).toEqual(["DRAFT", "SUBMITTED", "VERIFIED", "RECOMMENDED", "APPROVED", "DISBURSEMENT_PENDING", "ACTIVE"]);
    const panel = await exposurePanel(db, loanId);
    expect(panel.applicant.outstandingPrincipal).toBe(25_000_000n);
  });

  it("lets the Finance Manager return a voucher, and the Cashier prepare a new one", async () => {
    const { user } = await newMember();
    const { loanId } = await submitted(user);
    await verifyLoan(db, officer, loanId, "");
    await recommendLoan(db, officer, loanId, "Recommended for approval");
    await approveLoan(db, management, loanId, { amount: "300,000", tenure: "10", comment: "" });
    const input = { bankAccountId, valueDate: todayInLagos(), transferRef: "TRF-1", beneficiaryName: "Chinedu Okeke", beneficiaryBank: "GTBank", beneficiaryAccountNo: "0123456789" };
    const first = await prepareDisbursementVoucher(db, cashier, loanId, { ...input, evidenceId: await upload(cashier.id) });
    await expect(returnDisbursementVoucher(db, finance, first.id, "no")).rejects.toThrow(/Say why/);
    await returnDisbursementVoucher(db, finance, first.id, "Account number does not match the transfer");
    expect((await db.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe("APPROVED");
    const second = await prepareDisbursementVoucher(db, cashier, loanId, { ...input, transferRef: "TRF-2", evidenceId: await upload(cashier.id) });
    expect(second.status).toBe("PREPARED");
  });

  it("stops staff acting on their own loan, and members without complete KYC applying", async () => {
    const { user } = await newMember();
    const { loanId } = await submitted(user);
    await expect(verifyLoan(db, user, loanId, "")).rejects.toThrow(/your own loan/);
    await expect(declineLoan(db, officer, loanId, "no")).rejects.toThrow(/comment/);

    const noScan = await newMember(false);
    await expect(submitted(noScan.user)).rejects.toThrow(/KYC incomplete/);
  });

  it("[AT-u] refuses a third open loan and a guarantor's third guarantee, at submission and again at approval", async () => {
    const { member, user } = await newMember();
    const draft = await saveMemberApplication(db, user, application(), false);
    await submitted(user);
    await submitted(user);
    // A saved draft is not open; submitting it would make a third.
    const form = await upload(user.id);
    await expect(saveMemberApplication(db, user, { ...application(), guarantorFormEvidenceId: form }, true, draft.loanId)).rejects.toThrow(
      /already has 2 open loans; the limit is 2/,
    );
    await cancelMemberApplication(db, user, draft.loanId, "");

    // Guarantor already on two open loans (identified by phone as a non-member).
    const g = local(phone());
    const a = await newMember();
    const b = await newMember();
    const c = await newMember();
    await submitted(a.user, { guarantorPhone: g });
    await submitted(b.user, { guarantorPhone: g });
    await expect(submitted(c.user, { guarantorPhone: g })).rejects.toThrow(/guarantees 2 open loans; the limit is 2/);

    // At approval: a legacy ACTIVE loan arrived after submission (imports are never refused), so approving now would exceed the limit.
    const d = await newMember();
    const pending = await submitted(d.user);
    await submitted(d.user);
    await db.loan.create({
      data: { memberId: d.member.id, status: "ACTIVE", purpose: "Legacy", amountRequested: 1n, tenureRequested: 1, createdById: "legacy-import" },
    });
    await verifyLoan(db, officer, pending.loanId, "");
    await recommendLoan(db, officer, pending.loanId, "Recommended for approval");
    await expect(approveLoan(db, management, pending.loanId, { amount: "300,000", tenure: "10", comment: "" })).rejects.toThrow(/open loans; the limit is 2/);
    expect(member.id).toBeTruthy();
  });

  it("captures an assisted paper application straight to SUBMITTED with both signed forms", async () => {
    const { member } = await newMember();
    const result = await captureAssistedApplication(db, officer, member.id, {
      ...application(),
      guarantorFormEvidenceId: await upload(officer.id, "guarantor-form.pdf"),
      applicationFormEvidenceId: await upload(officer.id, "application-form.pdf"),
    });
    const loan = await db.loan.findUniqueOrThrow({ where: { id: result.loanId } });
    expect(loan).toMatchObject({ status: "SUBMITTED", assisted: true });
    const links = await db.evidenceLink.count({ where: { entityType: "Loan", entityId: loan.id, kind: "PRIMARY" } });
    expect(links).toBe(2);
  });
});
