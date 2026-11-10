/**
 * DEV ONLY. Rehearses the launch walkthrough (docs/launch-walkthrough.html)
 * against the dev database with the files in docs/launch-files, calling the
 * same functions the screens call, and checks every figure the page quotes.
 * One pass: it stops if the launch source already exists.
 * Run: npx --yes tsx@4.23.15 scripts/demo/rehearse-launch.mts
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: [".env.local", ".env.development.local"], quiet: true, override: true });
if (!/purple-river/.test(process.env.DATABASE_URL ?? "")) throw new Error("Not pointing at the dev branch; stopping.");
process.env.EVIDENCE_STORE = "local";
delete process.env.APP_STAGE;

const { createClient } = await import("@/lib/db");
const { todayInLagos } = await import("@/lib/dates");
const { formatNaira, kobo } = await import("@/lib/money");
const { getEvidenceStore } = await import("@/evidence/store");
const { beginUpload, finishUpload, storeEvidenceBytes } = await import("@/evidence/service");
const { approveChange, getDateSetting, proposeChange } = await import("@/shell/settings/settings");
const { createSource } = await import("@/modules/credit/members/sources");
const { createBankAccount, setBankAccountActive } = await import("@/modules/credit/banking/bank-accounts");
const { commitOpeningBalance, importStatement, uploadOpeningBalance } = await import("@/modules/credit/banking/statements");
const { matchVoucher, recordBankLineEntry, recordLodgement, verifyBankLineEntry, verifyLodgement } = await import("@/modules/credit/banking/matching");
const { commitMemberImport, previewMemberImport } = await import("@/modules/credit/members/member-import");
const { commitLegacyImport, previewLegacyImport } = await import("@/modules/credit/loans/legacy-import");
const { saveMemberApplication } = await import("@/modules/credit/loans/applications");
const { approveLoan, recommendLoan, verifyLoan } = await import("@/modules/credit/loans/review");
const { prepareDisbursementVoucher, verifyDisbursementVoucher } = await import("@/modules/credit/loans/disbursement");
const { loanLiveState } = await import("@/modules/credit/loans/repayments");
const { overpaymentCredit } = await import("@/modules/credit/loans/queries");
const { uploadSourceAdvice } = await import("@/modules/credit/remittance/source-advice");
const { commitSchedule, previewSchedule } = await import("@/modules/credit/remittance/schedules");
const { runReconciliation } = await import("@/modules/credit/reconciliation/reconciliation");
const { closeMonth, nextMonthToClose } = await import("@/modules/credit/reconciliation/close");
const { closeException, reviewException } = await import("@/shell/exceptions/exceptions");
const { approveRefund, captureRefundRequest, prepareRefundVoucher, verifyRefundVoucher } = await import("@/modules/credit/refunds/refunds");

const db = createClient(process.env.DATABASE_URL as string);
const store = getEvidenceStore();
const DIR = "docs/launch-files";
const file = (name: string) => ({ filename: name, bytes: new Uint8Array(readFileSync(`${DIR}/${name}`)) });
/** A fresh PDF each time, as real documents would be. */
const pdf = (name: string) => ({ filename: name, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) });
const who = (role: string) => ({ id: `rehearsal-${role}`, ipAddress: "127.0.0.1" });
const admin = who("admin"), fm = who("fm"), mgmt = who("mgmt"), officer = who("officer"), cashier = who("cashier"), treasurer = who("treasurer"), gmd = who("gmd");
const naira = (k: bigint) => formatNaira(kobo(k));
const today = todayInLagos();
const problems: string[] = [];

let n = 0;
async function step<T>(title: string, run: () => Promise<T>): Promise<T> {
  n++;
  try {
    const out = await run();
    console.log(`✓ ${n}. ${title}`);
    return out;
  } catch (error) {
    console.log(`✗ ${n}. ${title}\n   ${(error as Error).message}\n   ${JSON.stringify((error as { details?: unknown }).details ?? "")}`);
    throw error;
  }
}
function expectEq(what: string, got: unknown, want: unknown) {
  if (String(got) === String(want)) console.log(`     = ${what}: ${String(got)}`);
  else {
    console.log(`     ≠ ${what}: got ${String(got)}, the page says ${String(want)}`);
    problems.push(`${what}: got ${String(got)}, page says ${String(want)}`);
  }
}
async function refused(what: string, run: () => Promise<unknown>) {
  try {
    await run();
    console.log(`     ! NOT refused: ${what}`);
    problems.push(`Not refused: ${what}`);
  } catch (error) {
    console.log(`     ⊘ refused (${what}): ${(error as Error).message.slice(0, 110)}`);
  }
}

// A run that stopped part-way picks up after the legacy import.
const resume = !!(await db.remittanceSource.findUnique({ where: { code: "LAUNCH-PAYROLL" } }));
console.log(`Dev state: go_live=${await getDateSetting(db, "go_live_date", today)}, other accounts with an opening balance=${await db.bankOpeningBalance.count({ where: { status: "COMMITTED" } })}, closed months=${await db.periodClose.count()}`);

// Phase 1
if (!resume) await step("Admin proposes go-live 2026-10-01; Management approves", async () => {
  if ((await getDateSetting(db, "go_live_date", today)) === "2026-10-01") return;
  const req = await proposeChange(db, admin, { key: "go_live_date", value: "2026-10-01", effectiveFrom: today, reason: "Launch: the portal goes live on 1 October 2026" });
  await refused("Admin approves own proposal", () => approveChange(db, admin, req.id));
  await approveChange(db, mgmt, req.id);
  expectEq("go_live_date", await getDateSetting(db, "go_live_date", today), "2026-10-01");
});
if (!resume) await step("Admin adds LAUNCH-PAYROLL", () => createSource(db, admin, { code: "LAUNCH-PAYROLL", name: "Launch University payroll" }));
const account = resume ? await db.bankAccount.findFirstOrThrow({ where: { accountNumber: "3099100001" } }) : await step("Admin adds Union Bank (launch)", () => createBankAccount(db, admin, { bankName: "Union Bank (launch)", branch: "", accountName: "MOAUM Credit Super Store", accountNumber: "3099100001" }));
if (!resume) await step("Admin uploads ₦2,000,000 opening balance; Finance Manager commits", async () => {
  const opening = await uploadOpeningBalance(db, store, admin, { bankAccountId: account.id, asOf: "2026-10-01", amount: "2,000,000.00" }, pdf("bank-confirmation.pdf"));
  await refused("Admin commits own opening balance", () => commitOpeningBalance(db, admin, opening.id));
  await commitOpeningBalance(db, fm, opening.id);
});

// Phase 2
if (!resume) await step("Admin imports L1 members", async () => {
  const preview = await previewMemberImport(db, store, admin, "L1-members.csv", file("L1-members.csv").bytes);
  expectEq("valid member rows", preview.validCount, 8);
  await commitMemberImport(db, admin, preview.batchId);
});
const member = async (id: string) => db.member.findUniqueOrThrow({ where: { moaumIdNumber: id } });
const [adaeze, bem, comfort, dauda, kelechi] = await Promise.all(["001", "002", "003", "004", "005"].map((x) => member(`MA-LAUNCH-${x}`)));
console.log(`     members: status=${adaeze!.status}, memberNo=${adaeze!.memberNo}, staffNo=${adaeze!.payrollStaffNo}, idScan=${adaeze!.idScanEvidenceId}`);
const upload = async (userId: string, name: string) => {
  const a = { id: userId, ipAddress: null };
  const f = pdf(name);
  const begun = await beginUpload(db, store, a, { filename: name, size: f.bytes.length });
  await (store as unknown as { putFile(key: string, bytes: Uint8Array): Promise<void> }).putFile(`staging/${begun.uploadId}`, f.bytes);
  return (await finishUpload(db, store, a, begun.uploadId)).evidenceId;
};

// Phase 3
if (!resume) await step("Admin checks L2 legacy loans; Finance Manager brings them in", async () => {
  await refused("legacy file with the wrong go-live date", async () => {
    const wrong = await previewLegacyImport(db, store, admin, { goLiveDate: "2026-09-01", controlTotal: "480000", rowCount: "3" }, { ...file("L2-legacy-loans.csv"), filename: "L2-wrong-date.csv" });
    await commitLegacyImport(db, fm, wrong.batchId);
  });
  const preview = await previewLegacyImport(db, store, admin, { goLiveDate: "2026-10-01", controlTotal: "480000", rowCount: "3" }, file("L2-legacy-loans.csv"));
  expectEq("legacy preview ok", preview.ok, true);
  await refused("Admin brings in own legacy batch", () => commitLegacyImport(db, admin, preview.batchId));
  await commitLegacyImport(db, fm, preview.batchId);
});
const loanOf = async (memberId: string) => db.loan.findFirstOrThrow({ where: { memberId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
for (const [m, first] of [[adaeze!, "6125000"], [bem!, "7800000"], [comfort!, "5175000"]] as const) {
  const loan = await loanOf(m.id);
  const schedule = loan.bindingSchedule as { installments: Array<{ amount: string; dueDate: string }> };
  expectEq(`${m.fullName} first instalment (kobo)`, schedule.installments[0]?.amount, first);
  expectEq(`${m.fullName} first due`, schedule.installments[0]?.dueDate, "2026-11-01");
}

// Phase 4
const kelechiUser = { id: kelechi!.userId as string, ipAddress: "127.0.0.1" };
const existing = await db.loan.findFirst({ where: { memberId: kelechi!.id } });
const newLoanId = existing ? existing.id : await step("Kelechi applies; Loan Officer verifies and recommends; Management approves", async () => {
  if (!kelechi!.idScanEvidenceId) {
    await refused("Kelechi applies before the ID scan is on file", () =>
      saveMemberApplication(db, kelechiUser, { amount: "200,000", tenure: 6, purpose: "Shop stock for the season", guarantorIsMember: true, guarantorMoaumId: "MA-LAUNCH-006", guarantorAddress: "17 Old Otukpo Road, Makurdi", guarantorRelationship: "Colleague" }, false),
    );
    // Activation (the SMS link) is where the member uploads the ID scan.
    await db.member.update({ where: { id: kelechi!.id }, data: { idScanEvidenceId: await upload(kelechiUser.id, "id-card.pdf") } });
  }
  const form = await upload(kelechiUser.id, "guarantor-form.pdf");
  const { loanId } = await saveMemberApplication(
    db,
    kelechiUser,
    { amount: "200,000", tenure: 6, purpose: "Shop stock for the season", guarantorIsMember: true, guarantorMoaumId: "MA-LAUNCH-006", guarantorAddress: "17 Old Otukpo Road, Makurdi", guarantorRelationship: "Colleague", guarantorFormEvidenceId: form },
    true,
  );
  await verifyLoan(db, officer, loanId, "Guarantor form checked");
  await recommendLoan(db, officer, loanId, "Within limits");
  await approveLoan(db, mgmt, loanId, { amount: "200,000", tenure: "6", comment: "Approved" });
  return loanId;
});
if (!(await db.voucher.findFirst({ where: { transferRef: "TRF-L001", bankAccountId: account.id } }))) await step("Cashier prepares voucher TRF-L001 dated 2026-10-03; Finance Manager verifies", async () => {
  const voucher = await prepareDisbursementVoucher(db, cashier, newLoanId, {
    bankAccountId: account.id, valueDate: "2026-10-03", transferRef: "TRF-L001", beneficiaryName: "Kelechi Obi", beneficiaryBank: "First Bank", beneficiaryAccountNo: "3011122233", evidenceId: await upload(cashier.id, "transfer.pdf"),
  });
  await refused("Cashier verifies own voucher", () => verifyDisbursementVoucher(db, cashier, voucher.id));
  await verifyDisbursementVoucher(db, fm, voucher.id);
  const loan = await db.loan.findUniqueOrThrow({ where: { id: newLoanId } });
  const schedule = loan.bindingSchedule as { installments: Array<{ amount: string; dueDate: string }> };
  expectEq("new loan start", loan.d0?.toISOString().slice(0, 10), "2026-10-03");
  expectEq("new loan first instalment (kobo)", schedule.installments[0]?.amount, "4833333");
  expectEq("new loan first due", schedule.installments[0]?.dueDate, "2026-11-03");
});

// Phase 5
const posted = await db.remittanceSchedule.findFirst({ where: { scheduleReference: "SCH-LAUNCH-OCT" }, include: { rows: true } });
if (!posted) await step("Finance Manager uploads the Source Advice (L3)", async () => {
  const advice = await uploadSourceAdvice(db, store, fm, { remittanceSource: "LAUNCH-PAYROLL", monthCovered: "2026-10", adviceReference: "BURSARY/OCT/LAUNCH", controlTotal: "201000", rowCount: "4" }, file("L3-october-2026-salary-voucher.xlsx"), pdf("bursary-letter.pdf"));
  console.log(`     advice: ${JSON.stringify(advice, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 200)}`);
});
const schedule = posted ?? await step("Treasurer uploads and posts the schedule (L4)", async () => {
  const header = { scheduleReference: "SCH-LAUNCH-OCT", remittanceSource: "LAUNCH-PAYROLL", monthCovered: "2026-10", scheduleType: "REGULAR", adviceReference: "BURSARY/OCT/LAUNCH", submittedBy: "Treasurer", rowCount: "4" };
  await refused("schedule with control total 200,000", async () => {
    const bad = await previewSchedule(db, store, treasurer, { ...header, controlTotal: "200000" }, { ...file("L4-october-2026-schedule.xlsx"), filename: "L4-bad-total.xlsx" });
    await commitSchedule(db, treasurer, bad.batchId);
  });
  const preview = await previewSchedule(db, store, treasurer, { ...header, controlTotal: "201000" }, file("L4-october-2026-schedule.xlsx"));
  await commitSchedule(db, treasurer, preview.batchId);
  return db.remittanceSchedule.findFirstOrThrow({ where: { scheduleReference: "SCH-LAUNCH-OCT" }, include: { rows: true } });
});
{
  const loan = await loanOf(adaeze!.id);
  const events = await db.ledgerEvent.findMany({ where: { moduleEntityType: "Loan", moduleEntityId: loan.id, eventType: { in: ["INTEREST_INCOME", "PRINCIPAL_RECOVERY"] } } });
  const sum = (t: string) => events.filter((e) => e.eventType === t).reduce((s, e) => s + (t === "INTEREST_INCOME" ? e.interestAmount : e.principalAmount), 0n);
  expectEq("Adaeze interest paid", naira(sum("INTEREST_INCOME")), "₦11,250.00");
  expectEq("Adaeze principal paid", naira(sum("PRINCIPAL_RECOVERY")), "₦50,000.00");
  const live = await loanLiveState(db, loan);
  console.log(`     Adaeze live state keys: ${Object.keys(live ?? {}).join(", ")}`);
  expectEq("Dauda Overpayment Credit", naira(await overpaymentCredit(db, dauda!.id)), "₦10,000.00");
  expectEq("schedule rows", schedule.rows.length, 4);
}

// Phase 6
const banked = (await db.bankStatementLine.count({ where: { bankAccountId: account.id } })) > 0;
if (!banked) await step("Finance Manager imports the Union Bank statement (L5)", async () => {
  const input = { bankAccountId: account.id, periodFrom: "2026-10-02", periodTo: "2026-11-03", closingBalance: "2,008,395.00" };
  await refused("statement with opening 1,999,000.00", () => importStatement(db, store, fm, { ...input, openingBalance: "1,999,000.00" }, { ...file("L5-union-bank-statement-2026-10-02-to-11-03.csv"), filename: "L5-wrong-opening.csv" }));
  await importStatement(db, store, fm, { ...input, openingBalance: "2,000,000.00" }, file("L5-union-bank-statement-2026-10-02-to-11-03.csv"));
});
const lines = await db.bankStatementLine.findMany({ where: { bankAccountId: account.id }, orderBy: { transactionDate: "asc" } });
expectEq("statement lines", lines.length, 4);
const lineBy = (ref: string) => lines.find((l) => (l.reference ?? "") === ref)!;
const lodgement = await db.lodgement.findFirstOrThrow({ where: { scheduleId: schedule.id } });
if (!banked) await step("Finance Manager verifies lodgement SLIP-LP-1029 and matches TRF-L001", async () => {
  await refused("Cashier records an unverified lodgement", () => recordLodgement(db, cashier, lodgement.id));
  await verifyLodgement(db, fm, lineBy("SLIP-LP-1029").id, lodgement.id);
  const voucher = await db.voucher.findFirstOrThrow({ where: { transferRef: "TRF-L001", bankAccountId: account.id } });
  await matchVoucher(db, fm, lineBy("TRF-L001").id, voucher.id);
  const shortfall = await db.exceptionRecord.findUnique({ where: { dedupeKey: `SHORTFALL:${schedule.id}` } });
  expectEq("shortfall before the reconciliation run", shortfall ? naira(shortfall.amount ?? 0n) : "none", "none");
});
if (!banked) await step("Cashier records the lodgement and the ₦105 charge; Finance Manager verifies the charge", async () => {
  await recordLodgement(db, cashier, lodgement.id);
  await recordBankLineEntry(db, cashier, lineBy("SMSCHG").id, "BANK_CHARGE", "SMS alert charges, October");
  const entry = await db.bankLineEntry.findFirstOrThrow({ where: { lineId: lineBy("SMSCHG").id } });
  await refused("Cashier verifies own bank charge", () => verifyBankLineEntry(db, cashier, entry.id));
  await verifyBankLineEntry(db, fm, entry.id);
});

// Phase 7
// Dev leftovers: accounts with no opening balance would block the run (the screen says so).
for (const stray of await db.bankAccount.findMany({ where: { active: true, openings: { none: { status: "COMMITTED" } } } })) {
  await setBankAccountActive(db, admin, stray.id, false);
  console.log(`     deactivated unused dev account ${stray.bankName} ${stray.accountNumber}`);
}
expectEq("first month to close", await nextMonthToClose(db, today), "2026-10");
const run = await step("Finance Manager runs the October reconciliation", () => runReconciliation(db, fm, "2026-10"));
{
  const results = (run as { results?: unknown }).results ?? run;
  const text = JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const mine = (results as { accounts?: Array<Record<string, unknown>> }).accounts?.find((a) => JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("3099100001"));
  console.log(`     launch account position: ${JSON.stringify(mine, (_k, v) => (typeof v === "bigint" ? v.toString() : v))?.slice(0, 900)}`);
  console.log(`     run keys: ${Object.keys(results as object).join(", ")}; size ${text.length}`);
}
const open = await db.exceptionRecord.findMany({ where: { status: { not: "CLOSED" } }, select: { id: true, type: true, title: true, amount: true, status: true, dedupeKey: true } });
console.log(`     open exceptions (${open.length}): ${open.map((e) => `${e.type} ${e.amount ? naira(e.amount) : ""}`).join("; ")}`);
const shortfall = open.find((e) => e.dedupeKey === `SHORTFALL:${schedule.id}`)!;
await step("Finance Manager reviews the shortfall; GMD closes it", async () => {
  const evidence = async (name: string) => (await storeEvidenceBytes(db, store, fm, name, pdf(name).bytes)).evidenceId;
  const unknown = open.find((e) => e.type === "IN_BANK_NOT_IN_SYSTEM");
  if (unknown) await refused("GMD closes an exception nobody reviewed", async () => closeException(db, gmd, unknown.id, "Confirmed with the bank today.", await evidence("x.pdf")));
  await reviewException(db, fm, shortfall.id, "Bursary confirmed it lodged ₦5,000 short; the balance comes with November.", await evidence("bursary-note.pdf"));
  await refused("GMD closes without evidence", () => closeException(db, gmd, shortfall.id, "Confirmed with the bursary; balance follows in November.", null));
  await closeException(db, gmd, shortfall.id, "Confirmed with the bursary; balance follows in November.", await evidence("bursary-confirmation.pdf"));
});
await step("Finance Manager closes October", async () => {
  await refused("closing November", () => closeMonth(db, store, fm, "2026-11"));
  await closeMonth(db, store, fm, "2026-10");
  expectEq("next month to close", await nextMonthToClose(db, today), "2026-11");
});

// Phase 8
await step("Dauda's ₦10,000 refund: Loan Officer → Management → Cashier → Finance Manager", async () => {
  const request = { beneficiaryName: "Dauda Musa", beneficiaryBank: "First Bank", beneficiaryAccountNo: "3012345678" };
  await refused("refund of ₦12,000", () => captureRefundRequest(db, store, officer, "MA-LAUNCH-004", { ...request, amount: "12,000" }, pdf("request-12k.pdf")));
  const refund = await captureRefundRequest(db, store, officer, "MA-LAUNCH-004", { ...request, amount: "10,000" }, pdf("signed-request.pdf"));
  await approveRefund(db, mgmt, refund.id, "Approved");
  const voucher = await prepareRefundVoucher(db, store, cashier, refund.id, { bankAccountId: account.id, valueDate: today, transferRef: "TRF-RF-001" }, pdf("refund-transfer.pdf"));
  await verifyRefundVoucher(db, fm, voucher.id);
  expectEq("Dauda credit after refund", naira(await overpaymentCredit(db, dauda!.id)), "₦0.00");
});

console.log(`\nDuplicate-evidence exceptions on dev: ${await db.exceptionRecord.count({ where: { type: "DUPLICATE_EVIDENCE" } })}`);
console.log(problems.length ? `\nDIFFERENCES FROM THE PAGE (${problems.length}):\n- ${problems.join("\n- ")}` : "\nEverything matched the page.");
await db.$disconnect();
