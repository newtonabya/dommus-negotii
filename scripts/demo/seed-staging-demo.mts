/**
 * One-off demo data for STAGING only (not production): three staff logins, a
 * member login, a payroll source, a bank account, members, loans at every
 * stage, two months of payroll, a bank statement and some matching.
 *
 * Run: npx --yes tsx@4.19.2 scripts/demo/seed-staging-demo.mts
 * Reads .env.staging.local; writes the demo passwords to .env.demo.local
 * (git-ignored). Refuses to run twice (looks for the DEMO-PAYROLL source).
 * Everything goes through the app's own services, so every rule applies.
 */
import { randomBytes, randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import ExcelJS from "exceljs";

// DEMO_TARGET=dev rehearses against the dev branch (local evidence store) before touching staging.
const rehearsal = process.env.DEMO_TARGET === "dev";
// Later files override earlier ones: the dev file must come last, or .env.local's staging DATABASE_URL wins.
config({ path: rehearsal ? [".env.local", ".env.development.local"] : [".env.staging.local"], quiet: true, override: true });
if (rehearsal && !/purple-river/.test(process.env.DATABASE_URL ?? "")) throw new Error("Rehearsal is not pointing at the dev branch; stopping.");
if (!rehearsal && process.env.APP_STAGE !== "staging") throw new Error("This seed is for staging only (APP_STAGE=staging in .env.staging.local).");
if (rehearsal) process.env.EVIDENCE_STORE = "local";

const { generateRandomString, hashPassword } = await import("better-auth/crypto");
const { createClient } = await import("@/lib/db");
const { moduleForRole } = await import("@/shell/rbac/roles");
type Role = import("@/shell/rbac/roles").Role;
const { getEvidenceStore } = await import("@/evidence/store");
const { beginUpload, finishUpload, storeEvidenceBytes } = await import("@/evidence/service");
const { createSource } = await import("@/modules/credit/members/sources");
const { createBankAccount } = await import("@/modules/credit/banking/bank-accounts");
const { CONSENT_VERSION } = await import("@/modules/credit/members/rules");
const { captureAssistedApplication } = await import("@/modules/credit/loans/applications");
const { approveLoan, recommendLoan, verifyLoan } = await import("@/modules/credit/loans/review");
const { prepareDisbursementVoucher, verifyDisbursementVoucher } = await import("@/modules/credit/loans/disbursement");
const { uploadSourceAdvice } = await import("@/modules/credit/remittance/source-advice");
const { commitSchedule, loadSchedulePreview, previewSchedule } = await import("@/modules/credit/remittance/schedules");
const { commitOpeningBalance, importStatement, uploadOpeningBalance } = await import("@/modules/credit/banking/statements");
const { matchVoucher, recordBankLineEntry, recordLodgement, tagDirectPayment, verifyBankLineEntry, verifyLodgement } = await import("@/modules/credit/banking/matching");

const db = createClient(process.env.DATABASE_URL as string);
const store = getEvidenceStore();
const log = (s: string) => console.log(`· ${s}`);

if (await db.remittanceSource.findUnique({ where: { code: "DEMO-PAYROLL" } })) {
  console.log("Demo data is already on staging (DEMO-PAYROLL exists). Nothing done.");
  process.exit(0);
}

const password = () => `${generateRandomString(5, "a-z")}-${generateRandomString(5, "A-Z")}-${generateRandomString(5, "0-9")}-${generateRandomString(4, "a-z")}`;
const id32 = () => generateRandomString(32, "a-z", "A-Z", "0-9");
const seedActor = { id: "demo-seed", ipAddress: null };

// ───────────── Logins ─────────────
async function staff(name: string, email: string, roles: string[]) {
  const pw = password();
  const userId = id32();
  await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, name, email, emailVerified: true } });
    await tx.account.create({ data: { id: id32(), userId, providerId: "credential", accountId: userId, password: await hashPassword(pw) } });
    for (const role of roles) {
      await tx.userModuleRole.create({ data: { userId, moduleCode: moduleForRole(role as Role), role: role as Role, assignedById: "demo-seed" } });
    }
  });
  return { id: userId, ipAddress: null, email, password: pw, name };
}
const A = await staff("Ada Okafor (demo)", "demo.operations@dommus.invalid", ["LOAN_OFFICER", "CASHIER", "TREASURER"]);
const B = await staff("Bello Musa (demo)", "demo.finance@dommus.invalid", ["FINANCE_MANAGER", "MANAGEMENT", "SECRETARY", "AUDITOR"]);
const C = await staff("Chioma Eze (demo)", "demo.gmd@dommus.invalid", ["GMD"]);
log("staff logins created");

// ───────────── Evidence helpers ─────────────
const pdfBytes = (label: string) => new TextEncoder().encode(`%PDF-1.4\n% Dommus demo document: ${label} ${randomBytes(8).toString("hex")}\n%%EOF\n`);
const jpgBytes = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(256)]);
async function upload(actor: { id: string; ipAddress: null }, filename: string, bytes: Uint8Array) {
  const begun = await beginUpload(db, store, actor, { filename, size: bytes.length });
  await store.putFile(`staging/${begun.uploadId}`, bytes, filename.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
  return (await finishUpload(db, store, actor, begun.uploadId)).evidenceId;
}

// ───────────── Source, bank account, opening balance ─────────────
const source = await createSource(db, seedActor, { code: "DEMO-PAYROLL", name: "University payroll (demo)" });
const account = await createBankAccount(db, seedActor, { bankName: "First Bank (demo)", branch: "Makurdi", accountName: "MOAUM Credit Super Store", accountNumber: "3099000001" });
const opening = await uploadOpeningBalance(db, store, seedActor, { bankAccountId: account.id, asOf: "2026-08-31", amount: "5,000,000.00" }, { filename: "opening-statement.pdf", bytes: pdfBytes("opening") });
await commitOpeningBalance(db, B, opening.id);
log("source, bank account and opening balance");

// ───────────── Members ─────────────
const NAMES = ["Amina Bello", "Tunde Adeyemi", "Grace Okon", "Musa Ibrahim", "Ngozi Eze", "Terver Iorliam", "Halima Yusuf", "Emeka Nwosu"];
const memberPassword = password();
const members: Array<{ id: string; userId: string; fullName: string; moaumIdNumber: string; memberNo: string; staffNo: string; phone: string }> = [];
for (const [i, fullName] of NAMES.entries()) {
  const userId = id32();
  const phone = `+234803${String(randomInt(1_000_000, 9_999_999))}`;
  const scan = await storeEvidenceBytes(db, store, seedActor, `id-card-${i + 1}.jpg`, jpgBytes());
  const staffNo = `S0${3020 + i * 7}`;
  const m = await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, name: fullName, email: `member.${userId.slice(0, 10).toLowerCase()}@members.dommus.invalid`, phoneNumber: phone, phoneNumberVerified: true } });
    if (i === 0) await tx.account.create({ data: { id: id32(), userId, providerId: "credential", accountId: userId, password: await hashPassword(memberPassword) } });
    await tx.userModuleRole.create({ data: { userId, moduleCode: "CREDIT", role: "MEMBER", assignedById: "demo-seed" } });
    return tx.member.create({
      data: {
        userId,
        fullName,
        phone,
        address: `${10 + i} Old Otukpo Road, Makurdi, Benue`,
        moaumIdNumber: `MA-DEMO-${String(i + 1).padStart(3, "0")}`,
        idScanEvidenceId: scan.evidenceId,
        nextOfKinName: "Next of Kin (demo)",
        nextOfKinPhone: "+2347010000000",
        remittanceSourceId: source.id,
        payrollStaffNo: staffNo,
        status: "ACTIVE",
        consentAt: new Date(),
        consentVersion: CONSENT_VERSION,
        reviewedById: "demo-seed",
        reviewedAt: new Date(),
      },
    });
  });
  members.push({ id: m.id, userId, fullName, moaumIdNumber: m.moaumIdNumber, memberNo: m.memberNo, staffNo, phone });
}
log(`${members.length} members`);

// ───────────── Loans ─────────────
const guarantorPhone = () => `080${String(randomInt(10_000_000, 99_999_999))}`;
async function apply(memberIndex: number, amount: string, tenure: number, purpose: string) {
  const member = members[memberIndex]!;
  const form = await upload(A, "application-form.pdf", pdfBytes("application"));
  const guarantor = await upload(A, "guarantor-form.pdf", pdfBytes("guarantor"));
  const { loanId } = await captureAssistedApplication(db, A, member.id, {
    amount,
    tenure,
    purpose,
    guarantorIsMember: false,
    guarantorName: "Guarantor (demo)",
    guarantorPhone: guarantorPhone(),
    guarantorAddress: "4 Railway Quarters, Makurdi, Benue",
    guarantorRelationship: "Colleague",
    guarantorFormEvidenceId: guarantor,
    applicationFormEvidenceId: form,
  });
  return loanId;
}
async function disburse(loanId: string, memberIndex: number, amount: string, tenure: number, ref: string) {
  await verifyLoan(db, A, loanId, "ID card, application and guarantor form checked");
  await recommendLoan(db, A, loanId, "Good standing; repayment fits the payslip");
  await approveLoan(db, B, loanId, { amount, tenure: String(tenure), comment: "Approved at the loans meeting" });
  const transfer = await upload(A, `transfer-${ref}.pdf`, pdfBytes(`transfer ${ref}`));
  const voucher = await prepareDisbursementVoucher(db, A, loanId, {
    bankAccountId: account.id,
    valueDate: "2026-09-01",
    transferRef: ref,
    beneficiaryName: members[memberIndex]!.fullName,
    beneficiaryBank: "GTBank",
    beneficiaryAccountNo: `01${String(randomInt(10_000_000, 99_999_999))}`,
    evidenceId: transfer,
  });
  await verifyDisbursementVoucher(db, B, voucher.id);
  return voucher;
}
const disbursed = [
  { m: 0, amount: "300,000", tenure: 10, ref: "TRF-DEMO-001", purpose: "School fees for the new session" },
  { m: 1, amount: "200,000", tenure: 8, ref: "TRF-DEMO-002", purpose: "Shop stock for the festive season" },
  { m: 2, amount: "150,000", tenure: 6, ref: "TRF-DEMO-003", purpose: "Medical bills" },
  { m: 3, amount: "500,000", tenure: 12, ref: "TRF-DEMO-004", purpose: "Roofing the family house" },
];
const vouchers = [];
for (const d of disbursed) {
  const loanId = await apply(d.m, d.amount, d.tenure, d.purpose);
  vouchers.push(await disburse(loanId, d.m, d.amount, d.tenure, d.ref));
}
// Loans waiting at each desk, to click through.
const submitted = await apply(5, "120,000", 6, "Farm inputs for the dry season");
const recommended = await apply(6, "250,000", 10, "Rent for the new academic year");
await verifyLoan(db, A, recommended, "Documents checked");
await recommendLoan(db, A, recommended, "Recommended");
const approved = await apply(7, "180,000", 9, "Motorcycle for transport business");
await verifyLoan(db, A, approved, "Documents checked");
await recommendLoan(db, A, approved, "Recommended");
await approveLoan(db, B, approved, { amount: "180,000", tenure: "9", comment: "Approved" });
log(`4 loans paid out on 2026-09-01; 1 submitted (${submitted.slice(0, 8)}), 1 recommended, 1 approved`);

// ───────────── September payroll: the voucher exactly as it arrives ─────────────
const SEPT = [
  { m: 0, amount: 52_500 },
  { m: 1, amount: 40_000 },
  { m: 2, amount: 36_250 },
  { m: 3, amount: 80_000 },
  { m: 4, amount: 10_000 },
];
async function voucherFile(title: string, rows: Array<{ m: number; amount: number }>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow([title]);
  ws.addRow(["S/NO", "STAFF NAME", "STAFF NO", "MOAUM CONSULTANCY"]);
  rows.forEach((r, i) => ws.addRow([String(800 + i * 37), `${members[r.m]!.fullName.toUpperCase()}      `, members[r.m]!.staffNo, r.amount]));
  return { filename: `${title.toLowerCase().replace(/\s+/g, "-")}.xlsx`, bytes: new Uint8Array(await wb.xlsx.writeBuffer()) };
}
const total = (rows: Array<{ amount: number }>) => String(rows.reduce((t, r) => t + r.amount, 0));
const septFile = await voucherFile("SEPTEMBER 2026 SALARY VOUCHER", SEPT);
await uploadSourceAdvice(db, store, B, { remittanceSource: "DEMO-PAYROLL", monthCovered: "2026-09", adviceReference: "BURSARY/SEP/2026", controlTotal: total(SEPT), rowCount: String(SEPT.length) }, septFile, {
  filename: "bursary-letter-sep.pdf",
  bytes: pdfBytes("bursary september"),
});
const septPreview = await previewSchedule(
  db,
  store,
  A,
  { scheduleReference: "SCH-SEP-2026", remittanceSource: "DEMO-PAYROLL", monthCovered: "2026-09", scheduleType: "REGULAR", adviceReference: "BURSARY/SEP/2026", submittedBy: "Bursary, payroll unit", controlTotal: total(SEPT), rowCount: String(SEPT.length), paymentDate: "2026-09-28" },
  { ...septFile, filename: "sept-schedule-copy.xlsx" },
);
if (!septPreview.ok) throw new Error(`September dry run failed: ${JSON.stringify((await loadSchedulePreview(db, septPreview.batchId))?.stored.batchErrors)}`);
await commitSchedule(db, A, septPreview.batchId);
log("September payroll posted (payroll voucher format)");

// ───────────── October payroll: the template, with its bank lodgement ─────────────
const OCT = [
  { m: 0, amount: 52_500 },
  { m: 1, amount: 40_000 },
  { m: 2, amount: 36_250 },
  { m: 3, amount: 80_000 },
  { m: 4, amount: 10_000 },
];
const octAdvice = ["member_moaum_id,member_name,amount", ...OCT.map((r) => `${members[r.m]!.moaumIdNumber},${members[r.m]!.fullName},${r.amount}`)].join("\n");
await uploadSourceAdvice(db, store, B, { remittanceSource: "DEMO-PAYROLL", monthCovered: "2026-10", adviceReference: "BURSARY/OCT/2026", controlTotal: total(OCT), rowCount: String(OCT.length) }, { filename: "advice-oct.csv", bytes: new TextEncoder().encode(octAdvice) }, {
  filename: "bursary-letter-oct.pdf",
  bytes: pdfBytes("bursary october"),
});
const wb = new ExcelJS.Workbook();
const rowsSheet = wb.addWorksheet("Rows");
rowsSheet.addRow(["row_type", "member_moaum_id", "member_name", "loan_account_no", "amount_paid", "payment_date"]);
for (const r of OCT) rowsSheet.addRow(["PAYROLL", members[r.m]!.moaumIdNumber, members[r.m]!.fullName, "", String(r.amount), "2026-10-28"]);
const lodgeSheet = wb.addWorksheet("Lodgements");
lodgeSheet.addRow(["bank_account", "deposit_date", "reference", "amount", "depositor", "note"]);
lodgeSheet.addRow([account.accountNumber, "2026-10-29", "SLIP-OCT-0291", total(OCT), "Bursary", "October deductions"]);
const octPreview = await previewSchedule(
  db,
  store,
  A,
  { scheduleReference: "SCH-OCT-2026", remittanceSource: "DEMO-PAYROLL", monthCovered: "2026-10", scheduleType: "REGULAR", adviceReference: "BURSARY/OCT/2026", submittedBy: "Bursary, payroll unit", controlTotal: total(OCT), rowCount: String(OCT.length) },
  { filename: "oct-schedule.xlsx", bytes: new Uint8Array(await wb.xlsx.writeBuffer()) },
);
if (!octPreview.ok) throw new Error(`October dry run failed: ${JSON.stringify((await loadSchedulePreview(db, octPreview.batchId))?.stored.batchErrors)}`);
await commitSchedule(db, A, octPreview.batchId);
log("October payroll posted (template with a lodgement line)");

// ───────────── Bank statement September–October ─────────────
const lines: Array<[string, string, string, string, string]> = [
  ["2026-09-01", "TRF-DEMO-001", "TRANSFER TO AMINA BELLO", "300000", ""],
  ["2026-09-01", "TRF-DEMO-002", "TRANSFER TO TUNDE ADEYEMI", "200000", ""],
  ["2026-09-01", "TRF-DEMO-003", "TRANSFER TO GRACE OKON", "150000", ""],
  ["2026-09-01", "TRF-DEMO-004", "TRANSFER TO MUSA IBRAHIM", "500000", ""],
  ["2026-09-30", "BURS-SEP", "BURSARY UNIVERSITY SEPT DEDUCTIONS", "", total(SEPT)],
  ["2026-10-15", "NIP-77231", "TRANSFER FROM NGOZI EZE", "", "25000"],
  ["2026-10-29", "SLIP-OCT-0291", "CASH DEPOSIT BURSARY", "", total(OCT)],
  ["2026-10-31", "SMSCHG", "SMS ALERT CHARGES OCT", "157.50", ""],
  ["2026-10-31", "INT", "CREDIT INTEREST", "", "1234.56"],
];
const toKobo = (s: string) => (s ? BigInt(Math.round(Number(s) * 100)) : 0n);
const closing = lines.reduce((t, l) => t - toKobo(l[3]) + toKobo(l[4]), 500_000_000n);
const csv = ["FIRST BANK STATEMENT 3099000001 SEP-OCT 2026", "transaction_date,reference,narration,debit,credit", ...lines.map((l) => l.join(","))].join("\n");
const naira = (k: bigint) => `${k / 100n}.${String(k % 100n).padStart(2, "0")}`;
const statement = await importStatement(db, store, B, { bankAccountId: account.id, periodFrom: "2026-09-01", periodTo: "2026-10-31", openingBalance: "5000000.00", closingBalance: naira(closing) }, { filename: "statement-sep-oct-2026.csv", bytes: new TextEncoder().encode(csv) });
const stLines = await db.bankStatementLine.findMany({ where: { statementId: statement.id } });
const line = (ref: string) => stLines.find((l) => l.reference === ref)!;
log(`statement imported (${stLines.length} lines, closing ₦${naira(closing)})`);

// Matching: some done, some left for you to try.
const octLodgement = await db.lodgement.findFirstOrThrow({ where: { reference: "SLIP-OCT-0291" } });
await verifyLodgement(db, B, line("SLIP-OCT-0291").id, octLodgement.id);
await recordLodgement(db, A, octLodgement.id);
for (const v of vouchers.slice(0, 3)) await matchVoucher(db, B, line(v.transferRef).id, v.id);
const charge = await recordBankLineEntry(db, A, line("SMSCHG").id, "BANK_CHARGE", "Monthly SMS alerts");
await verifyBankLineEntry(db, B, charge.id);
await tagDirectPayment(db, store, B, line("NIP-77231").id, { member: members[4]!.memberNo, note: "Member's own transfer" }, null);
log("matched: October lodgement (verified and recorded), 3 disbursements, the SMS charge; tagged the direct transfer");

// ───────────── Logins file ─────────────
const site = "https://dommus-negotii-staging.vercel.app";
writeFileSync(
  rehearsal ? ".env.demo-rehearsal.local" : ".env.demo.local",
  [
    `# Demo logins for STAGING only (${site}). Created ${new Date().toISOString()}. Never use these in production.`,
    `# Staff must set up an authenticator app at first sign-in (Google Authenticator, Microsoft Authenticator, etc.).`,
    `DEMO_OPERATIONS_EMAIL=${A.email}  # Loan Officer + Cashier + Treasurer`,
    `DEMO_OPERATIONS_PASSWORD=${A.password}`,
    `DEMO_FINANCE_EMAIL=${B.email}  # Finance Manager + Management + Secretary + Auditor`,
    `DEMO_FINANCE_PASSWORD=${B.password}`,
    `DEMO_GMD_EMAIL=${C.email}  # GMD`,
    `DEMO_GMD_PASSWORD=${C.password}`,
    `DEMO_MEMBER_PHONE=0${members[0]!.phone.slice(4)}  # ${members[0]!.fullName}, ${members[0]!.memberNo}; sign in on the Member tab`,
    `DEMO_MEMBER_PASSWORD=${memberPassword}`,
    "",
  ].join("\n"),
);
console.log(`Done. Logins written to ${rehearsal ? ".env.demo-rehearsal.local" : ".env.demo.local"}`);
await db.$disconnect();
