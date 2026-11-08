/**
 * STAGING ONLY. One demo login per actor (single role each, so access and dual
 * control show exactly as in real use), member logins at every stage, an open
 * invitation for the applicant, and sample upload files for the test scenarios.
 * Run after seed-staging-demo.mts:
 *   npx --yes tsx@4.23.15 scripts/demo/seed-staging-actors.mts
 * Safe to run again: existing logins are kept, their passwords carried over
 * from .env.demo.local. Writes .env.demo.local (git-ignored) and docs/demo-files/.
 */
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import ExcelJS from "exceljs";

config({ path: [".env.staging.local"], quiet: true, override: true });
if (process.env.APP_STAGE !== "staging") throw new Error("Staging only (APP_STAGE=staging in .env.staging.local).");
if (!/divine-violet/.test(process.env.DATABASE_URL ?? "")) throw new Error("DATABASE_URL is not the staging branch; stopping.");

const { generateRandomString, hashPassword } = await import("better-auth/crypto");
const { createClient } = await import("@/lib/db");
const { getEvidenceStore } = await import("@/evidence/store");
const { storeEvidenceBytes } = await import("@/evidence/service");
const { moduleForRole } = await import("@/shell/rbac/roles");
const { CONSENT_VERSION } = await import("@/modules/credit/members/rules");
const { createInvitation } = await import("@/modules/credit/members/invitations");
type Role = import("@/shell/rbac/roles").Role;

const db = createClient(process.env.DATABASE_URL as string);
const store = getEvidenceStore();
const log = (s: string) => console.log(`· ${s}`);
const id32 = () => generateRandomString(32, "a-z", "A-Z", "0-9");
const newPassword = () => `${generateRandomString(5, "a-z")}-${generateRandomString(5, "A-Z")}-${generateRandomString(5, "0-9")}-${generateRandomString(4, "a-z")}`;

const source = await db.remittanceSource.findUnique({ where: { code: "DEMO-PAYROLL" } });
if (!source) throw new Error("Run seed-staging-demo.mts first (no DEMO-PAYROLL source).");

// Passwords already handed out stay valid: read them back from the logins file.
const known = new Map<string, string>();
if (existsSync(".env.demo.local")) {
  const lines = readFileSync(".env.demo.local", "utf8").split(/\r?\n/);
  const value = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).split("  #")[0]?.trim();
  const memberPhone = value("DEMO_MEMBER_PHONE");
  const memberPw = value("DEMO_MEMBER_PASSWORD");
  if (memberPhone && memberPw) known.set(memberPhone, memberPw);
  for (const prefix of ["DEMO_OPERATIONS", "DEMO_FINANCE", "DEMO_GMD"]) {
    const email = value(`${prefix}_EMAIL`);
    const pw = value(`${prefix}_PASSWORD`);
    if (email && pw) known.set(email, pw);
  }
  for (const l of lines) {
    const m = /^(\S+?)\s*\|\s*(\S+)\s*\|\s*(\S+)/.exec(l.replace(/^#\s*/, ""));
    if (m && m[2]!.includes("@") && m[3] !== "password") known.set(m[2]!, m[3]!);
    if (m && m[2]!.startsWith("0") && m[3] !== "password") known.set(m[2]!, m[3]!);
  }
}

interface Login {
  actor: string;
  roles: string;
  signIn: string;
  password: string;
  tab: "Staff" | "Member";
}
const logins: Login[] = [];

async function staffLogin(actor: string, name: string, email: string, role: Role) {
  let user = await db.user.findUnique({ where: { email } });
  let password = known.get(email);
  if (!user) {
    password = newPassword();
    const userId = id32();
    await db.$transaction(async (tx) => {
      await tx.user.create({ data: { id: userId, name, email, emailVerified: true } });
      await tx.account.create({ data: { id: id32(), userId, providerId: "credential", accountId: userId, password: await hashPassword(password as string) } });
      await tx.userModuleRole.create({ data: { userId, moduleCode: moduleForRole(role), role, assignedById: "demo-seed" } });
    });
    user = await db.user.findUniqueOrThrow({ where: { email } });
  }
  logins.push({ actor, roles: role, signIn: email, password: password ?? "(unchanged: see the earlier logins file)", tab: "Staff" });
  return { id: user.id, ipAddress: null };
}

const admin = await staffLogin("Admin", "Adaeze Admin (demo)", "demo.admin@dommus.invalid", "ADMIN");
const secretary = await staffLogin("Secretary", "Salamatu Secretary (demo)", "demo.secretary@dommus.invalid", "SECRETARY");
await staffLogin("Loan Officer", "Lanre Loans (demo)", "demo.loanofficer@dommus.invalid", "LOAN_OFFICER");
await staffLogin("Cashier", "Kemi Cashier (demo)", "demo.cashier@dommus.invalid", "CASHIER");
await staffLogin("Treasurer", "Tobi Treasurer (demo)", "demo.treasurer@dommus.invalid", "TREASURER");
await staffLogin("Finance Manager", "Fola Finance (demo)", "demo.financemanager@dommus.invalid", "FINANCE_MANAGER");
await staffLogin("Management", "Musa Management (demo)", "demo.management@dommus.invalid", "MANAGEMENT");
await staffLogin("Auditor", "Aisha Auditor (demo)", "demo.auditor@dommus.invalid", "AUDITOR");
const gmd = await db.user.findUnique({ where: { email: "demo.gmd@dommus.invalid" } });
if (gmd) logins.push({ actor: "GMD", roles: "GMD", signIn: gmd.email, password: known.get(gmd.email) ?? "(see the earlier logins file)", tab: "Staff" });
else await staffLogin("GMD", "Chioma Eze (demo)", "demo.gmd@dommus.invalid", "GMD");
void admin;
log("staff logins: one per role");

// ───────────── Members at every stage ─────────────
async function memberLogin(actor: string, moaumId: string) {
  const member = await db.member.findUniqueOrThrow({ where: { moaumIdNumber: moaumId } });
  const local = `0${member.phone.slice(4)}`;
  let password = known.get(local);
  const account = await db.account.findFirst({ where: { userId: member.userId, providerId: "credential" } });
  if (!account) {
    password = newPassword();
    await db.account.create({ data: { id: id32(), userId: member.userId, providerId: "credential", accountId: member.userId, password: await hashPassword(password) } });
  }
  logins.push({ actor: `${actor}: ${member.fullName} (${member.memberNo})`, roles: "MEMBER", signIn: local, password: password ?? "(see the earlier logins file)", tab: "Member" });
  return member;
}
await memberLogin("Borrower with an active loan and repayments", "MA-DEMO-001");
await memberLogin("Member with no loan, holding Overpayment Credit", "MA-DEMO-005");
await memberLogin("Applicant whose loan waits for the Loan Officer", "MA-DEMO-006");

// A registered member waiting for the Loan Officer to activate them.
let pending = await db.member.findUnique({ where: { moaumIdNumber: "MA-DEMO-009" } });
if (!pending) {
  const userId = id32();
  const phone = `+234806${String(randomInt(1_000_000, 9_999_999))}`;
  const scan = await storeEvidenceBytes(db, store, { id: "demo-seed", ipAddress: null }, "id-card-pending.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(256)]));
  const password = newPassword();
  await db.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, name: "Fatima Danjuma", email: `member.${userId.slice(0, 10).toLowerCase()}@members.dommus.invalid`, phoneNumber: phone, phoneNumberVerified: true } });
    await tx.account.create({ data: { id: id32(), userId, providerId: "credential", accountId: userId, password: await hashPassword(password) } });
    await tx.member.create({
      data: {
        userId,
        fullName: "Fatima Danjuma",
        phone,
        address: "22 Gboko Road, Makurdi, Benue",
        moaumIdNumber: "MA-DEMO-009",
        idScanEvidenceId: scan.evidenceId,
        nextOfKinName: "Next of Kin (demo)",
        nextOfKinPhone: "+2347010000000",
        remittanceSourceId: source.id,
        status: "PENDING",
        consentAt: new Date(),
        consentVersion: CONSENT_VERSION,
      },
    });
  });
  known.set(`0${phone.slice(4)}`, password);
  pending = await db.member.findUniqueOrThrow({ where: { moaumIdNumber: "MA-DEMO-009" } });
}
logins.push({ actor: `Registered, waiting for activation: ${pending.fullName}`, roles: "(none until activated)", signIn: `0${pending.phone.slice(4)}`, password: known.get(`0${pending.phone.slice(4)}`) ?? "(see the earlier logins file)", tab: "Member" });

// An applicant with an open invitation: the link is in the staging outbox.
const applicantPhone = `0807${String(randomInt(1_000_000, 9_999_999))}`;
await createInvitation(db, secretary, { fullName: "Peter Agbo (demo applicant)", phone: applicantPhone, email: "", remittanceSourceId: source.id });
logins.push({ actor: "Applicant (invited, not registered yet): Peter Agbo", roles: "none", signIn: applicantPhone, password: "chosen at registration: open the link in Admin → Staging outbox", tab: "Member" });
log("members at every stage and an open invitation");

// ───────────── Sample files for the scenarios ─────────────
mkdirSync("docs/demo-files", { recursive: true });
const members = await db.member.findMany({ where: { moaumIdNumber: { in: ["MA-DEMO-001", "MA-DEMO-002", "MA-DEMO-003", "MA-DEMO-004", "MA-DEMO-005"] } }, orderBy: { moaumIdNumber: "asc" } });
const NOV = [52_500, 40_000, 36_250, 80_000, 10_000];
const novTotal = NOV.reduce((t, a) => t + a, 0);
const account = await db.bankAccount.findUniqueOrThrow({ where: { accountNumber: "3099000001" } });

async function voucher(file: string, title: string, rows: Array<[string, string, string, number]>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow([title]);
  ws.addRow(["S/NO", "STAFF NAME", "STAFF NO", "MOAUM CONSULTANCY"]);
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(`docs/demo-files/${file}`);
}
const voucherRows = members.map((m, i): [string, string, string, number] => [String(900 + i * 13), `${m.fullName.toUpperCase()}      `, m.payrollStaffNo ?? "", NOV[i]!]);
await voucher("1-november-2026-salary-voucher.xlsx", "NOVEMBER 2026 SALARY VOUCHER", voucherRows);
await voucher("x-voucher-wrong-month.xlsx", "OCTOBER 2026 SALARY VOUCHER", voucherRows);
await voucher("x-voucher-unknown-staff-number.xlsx", "NOVEMBER 2026 SALARY VOUCHER", [...voucherRows.slice(0, 4), ["999", "JOHN NOBODY", "S99999", NOV[4]!]]);

async function schedule(file: string, amounts: number[]) {
  const wb = new ExcelJS.Workbook();
  const rows = wb.addWorksheet("Rows");
  rows.addRow(["row_type", "member_moaum_id", "member_name", "loan_account_no", "amount_paid", "payment_date", "period_covered", "receipt_no", "bank_credit_ref", "row_note"]);
  members.forEach((m, i) => rows.addRow(["PAYROLL", m.moaumIdNumber, m.fullName, "", String(amounts[i]), "2026-11-05", "", "", "", ""]));
  const lodge = wb.addWorksheet("Lodgements");
  lodge.addRow(["bank_account", "deposit_date", "reference", "amount", "depositor", "note"]);
  lodge.addRow([account.accountNumber, "2026-11-06", "SLIP-NOV-0412", String(novTotal), "Bursary", "November deductions"]);
  await wb.xlsx.writeFile(`docs/demo-files/${file}`);
}
await schedule("2-november-2026-schedule-with-lodgement.xlsx", NOV);
await schedule("x-schedule-moves-2500-between-members.xlsx", [NOV[0]! - 2_500, NOV[1]! + 2_500, ...NOV.slice(2)]);

const lastStatement = await db.bankStatement.findFirstOrThrow({ where: { bankAccountId: account.id }, orderBy: { periodTo: "desc" } });
const opening = lastStatement.closingBalance;
const stmt: Array<[string, string, string, string, string]> = [
  ["2026-11-03", "NIP-90112", "TRANSFER FROM NGOZI EZE", "", "15000.00"],
  ["2026-11-06", "SLIP-NOV-0412", "CASH DEPOSIT BURSARY", "", `${novTotal}.00`],
  ["2026-11-07", "SMSCHG", "SMS ALERT CHARGES NOV", "52.50", ""],
];
const kobo = (s: string) => (s ? BigInt(s.replace(".", "")) : 0n);
const closing = stmt.reduce((t, l) => t - kobo(l[3]) + kobo(l[4]), opening);
const naira = (k: bigint) => `${k / 100n}.${String(k % 100n).padStart(2, "0")}`;
writeFileSync("docs/demo-files/3-bank-statement-2026-11-01-to-07.csv", ["transaction_date,reference,narration,debit,credit", ...stmt.map((l) => l.join(","))].join("\n") + "\n");

const phone = () => `0809${String(randomInt(1_000_000, 9_999_999))}`;
writeFileSync(
  "docs/demo-files/4-member-import.csv",
  [
    "full_name,phone,email,address,moaum_id_number,next_of_kin_name,next_of_kin_phone,remittance_source_code,payroll_staff_no",
    `Joseph Ochai,${phone()},,"8 Wurukum Market Road, Makurdi",MA-DEMO-101,Mary Ochai,${phone()},DEMO-PAYROLL,S04101`,
    `Rebecca Aondo,${phone()},,"15 High Level, Makurdi",MA-DEMO-102,John Aondo,${phone()},DEMO-PAYROLL,S04102`,
  ].join("\n") + "\n",
);
writeFileSync("docs/demo-files/5-invitations.csv", ["full_name,phone,email,remittance_source_code", `Blessing Iyorwuese,${phone()},,DEMO-PAYROLL`, `Samuel Ogbu,${phone()},,NONE`].join("\n") + "\n");
writeFileSync("docs/demo-files/6-sample-document.pdf", `%PDF-1.4\n% Dommus demo document. Use it wherever a PDF is asked for: guarantor form, application form, letters.\n%%EOF\n`);
writeFileSync("docs/demo-files/7-sample-id-card.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(512)]));
writeFileSync(
  "docs/demo-files/README.md",
  [
    "# Demo files for staging tests",
    "",
    "Made for the staging demo data (source DEMO-PAYROLL, account 3099000001). Fake people; never use in production.",
    "",
    "| File | Who uploads it | Where |",
    "|---|---|---|",
    `| 1-november-2026-salary-voucher.xlsx | Finance Manager (as Source Advice: month 2026-11, control total ${novTotal}, 5 rows) | Remittance → Upload a Source Advice |`,
    `| 2-november-2026-schedule-with-lodgement.xlsx | Treasurer (REGULAR, month 2026-11, advice = the one above, control total ${novTotal}, 5 rows) | Remittance → Upload a remittance schedule |`,
    `| 3-bank-statement-2026-11-01-to-07.csv | Finance Manager (period 2026-11-01 to 2026-11-07, opening ${naira(opening)}, closing ${naira(closing)}) | Bank → Import a statement |`,
    "| 4-member-import.csv | Admin | Import members |",
    "| 5-invitations.csv | Secretary | Invitations → bulk |",
    "| 6-sample-document.pdf, 7-sample-id-card.jpg | anyone asked for a document or ID scan | any upload field |",
    "| x-voucher-wrong-month.xlsx | Finance Manager or Treasurer: must be refused (month) | |",
    "| x-voucher-unknown-staff-number.xlsx | must be refused (staff number not linked) | |",
    "| x-schedule-moves-2500-between-members.xlsx | Treasurer: dry run must refuse (advice mismatch, AT-l) | |",
    "",
  ].join("\n"),
);
log("sample files in docs/demo-files");

// ───────────── Logins file ─────────────
if (existsSync(".env.demo.local")) writeFileSync(".env.demo.previous.local", readFileSync(".env.demo.local"));
const site = "https://dommus-negotii-staging.vercel.app";
writeFileSync(
  ".env.demo.local",
  [
    `# STAGING demo logins (${site}). Updated ${new Date().toISOString()}. Never use in production.`,
    "# Staff: sign in on the Staff tab with the email, then set up an authenticator app (one entry per login).",
    "# Members: sign in on the Member tab with the phone number.",
    "# Invitation links and phone codes: sign in as Admin, open Staging outbox.",
    "#",
    "# actor | sign in with | password | roles | tab",
    ...logins.map((l) => `# ${l.actor.replace(/\s+/g, "_")} | ${l.signIn} | ${l.password} | ${l.roles} | ${l.tab}`),
    "#",
    "# Earlier combined logins (still work): operations = Loan Officer+Cashier+Treasurer, finance = Finance Manager+Management+Secretary+Auditor.",
    ...[...known]
      .filter(([k]) => k === "demo.operations@dommus.invalid" || k === "demo.finance@dommus.invalid")
      .map(([k, v]) => `# combined | ${k} | ${v}`),
    "",
  ].join("\n"),
);
writeFileSync(
  "docs/demo-files/logins-public.json",
  JSON.stringify(
    logins.map(({ actor, roles, signIn, tab }) => ({ actor, roles, signIn, tab })),
    null,
    2,
  ),
);
console.log(`Done. ${logins.length} logins in .env.demo.local`);
await db.$disconnect();
