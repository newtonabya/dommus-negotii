/**
 * Writes the files for the staging launch walkthrough (docs/launch-files) and
 * the figures it quotes (figures.json), computed with the app's own loan
 * engine. No database: the walkthrough's user does every step on staging.
 * Run: npx --yes tsx@4.23.15 scripts/demo/make-launch-files.mts
 */
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";

const { planSchedule } = await import("@/modules/credit/domain/schedule");
const { localDate } = await import("@/lib/dates");
const { bps, kobo, formatNaira } = await import("@/lib/money");

const DIR = "docs/launch-files";
mkdirSync(DIR, { recursive: true });
const ACCOUNT = "3099100001";
const SOURCE = "LAUNCH-PAYROLL";
const GO_LIVE = "2026-10-01";
const naira = (k: bigint) => formatNaira(kobo(k));
const plain = (k: bigint) => `${k / 100n}.${String(k % 100n).padStart(2, "0")}`;
const phone = () => `080${randomInt(10_000_000, 99_999_999)}`;

const MEMBERS = [
  { name: "Adaeze Okoro", pin: "LP1001", role: "Legacy loan: owes ₦150,000 over 3 months" },
  { name: "Bem Tyokaa", pin: "LP1002", role: "Legacy loan: owes ₦240,000 over 4 months" },
  { name: "Comfort Agbo", pin: "LP1003", role: "Legacy loan: owes ₦90,000 over 2 months" },
  { name: "Dauda Musa", pin: "LP1004", role: "No loan: his October deduction becomes Overpayment Credit" },
  { name: "Kelechi Obi", pin: "LP1005", role: "Applies online for a new ₦200,000 loan" },
  { name: "Funmi Adeyemi", pin: "LP1006", role: "Member, no activity yet" },
  { name: "Gabriel Ikpa", pin: "LP1007", role: "Member, no activity yet" },
  { name: "Hauwa Bello", pin: "LP1008", role: "Member, no activity yet" },
].map((m, i) => ({ ...m, moaumId: `MA-LAUNCH-${String(i + 1).padStart(3, "0")}`, phone: phone() }));

// 1. Members to import (Admin).
writeFileSync(
  `${DIR}/L1-members.csv`,
  [
    "full_name,phone,email,address,moaum_id_number,next_of_kin_name,next_of_kin_phone,remittance_source_code,payroll_staff_no",
    ...MEMBERS.map((m, i) => `${m.name},${m.phone},,"${12 + i} Old Otukpo Road, Makurdi",${m.moaumId},Next of Kin ${i + 1},${phone()},${SOURCE},${m.pin}`),
  ].join("\n") + "\n",
);

// 2. Legacy loans as MOAUM keeps them (Admin).
const LEGACY = [
  { m: MEMBERS[0]!, owed: 15_000_000n, months: 3 },
  { m: MEMBERS[1]!, owed: 24_000_000n, months: 4 },
  { m: MEMBERS[2]!, owed: 9_000_000n, months: 2 },
];
writeFileSync(
  `${DIR}/L2-legacy-loans.csv`,
  ["SN,Name,PIN,Department,Tenure,Principal", ...LEGACY.map((l, i) => `${i + 1},${l.m.name},${l.m.pin},Bursary,${l.months},${plain(l.owed)}`)].join("\n") + "\n",
);
const legacyPlans = LEGACY.map((l) => {
  const s = planSchedule({ principal: kobo(l.owed), tenure: l.months, rate: bps(750n), d0: localDate(GO_LIVE) });
  return { name: l.m.name, pin: l.m.pin, owed: l.owed, months: l.months, first: s.installments[0]!.amount, firstInterest: s.installments[0]!.interest, firstPrincipal: s.installments[0]!.principal, due: s.installments[0]!.dueDate };
});
const legacyTotal = LEGACY.reduce((t, l) => t + l.owed, 0n);

// 3. October payroll: each legacy borrower's first instalment, and Dauda (no loan).
const OCT = [...legacyPlans.map((p) => ({ m: MEMBERS.find((x) => x.pin === p.pin)!, amount: p.first })), { m: MEMBERS[3]!, amount: 1_000_000n }];
const octTotal = OCT.reduce((t, r) => t + r.amount, 0n);
const lodged = octTotal - 500_000n; // the bursary lodges ₦5,000 short: a shortfall at reconciliation
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["OCTOBER 2026 SALARY VOUCHER"]);
  ws.addRow(["S/NO", "STAFF NAME", "STAFF NO", "MOAUM CONSULTANCY"]);
  OCT.forEach((r, i) => ws.addRow([String(700 + i * 17), `${r.m.name.toUpperCase()}      `, r.m.pin, Number(plain(r.amount))]));
  await wb.xlsx.writeFile(`${DIR}/L3-october-2026-salary-voucher.xlsx`);
}
{
  const wb = new ExcelJS.Workbook();
  const rows = wb.addWorksheet("Rows");
  rows.addRow(["row_type", "member_moaum_id", "member_name", "loan_account_no", "amount_paid", "payment_date", "period_covered", "receipt_no", "bank_credit_ref", "row_note"]);
  for (const r of OCT) rows.addRow(["PAYROLL", r.m.moaumId, r.m.name, "", plain(r.amount), "2026-10-28", "October 2026", "", "", ""]);
  const lodge = wb.addWorksheet("Lodgements");
  lodge.addRow(["bank_account", "deposit_date", "reference", "amount", "depositor", "note"]);
  lodge.addRow([ACCOUNT, "2026-10-29", "SLIP-LP-1029", plain(lodged), "Bursary", "October deductions"]);
  await wb.xlsx.writeFile(`${DIR}/L4-october-2026-schedule.xlsx`);
}

// 4. New loan: Kelechi, ₦200,000 over 6 months, paid out 3 October.
const newLoan = planSchedule({ principal: kobo(20_000_000n), tenure: 6, rate: bps(750n), d0: localDate("2026-10-03") });

// 5. The launch account's statement, 2 October to 3 November.
const opening = 200_000_000n;
const lines: Array<[string, string, string, bigint, bigint]> = [
  ["2026-10-03", "TRF-L001", "TRANSFER TO KELECHI OBI", 20_000_000n, 0n],
  ["2026-10-29", "SLIP-LP-1029", "CASH DEPOSIT BURSARY", 0n, lodged],
  ["2026-10-30", "", "CASH DEPOSIT UNKNOWN", 0n, 1_250_000n],
  ["2026-10-31", "SMSCHG", "SMS ALERT CHARGES OCT", 10_500n, 0n],
];
const closing = lines.reduce((t, l) => t - l[3] + l[4], opening);
writeFileSync(
  `${DIR}/L5-union-bank-statement-2026-10-02-to-11-03.csv`,
  [`UNION BANK (LAUNCH) ${ACCOUNT} STATEMENT`, "transaction_date,reference,narration,debit,credit", ...lines.map((l) => [l[0], l[1], l[2], l[3] ? plain(l[3]) : "", l[4] ? plain(l[4]) : ""].join(","))].join("\n") + "\n",
);
writeFileSync(`${DIR}/L6-document.pdf`, "%PDF-1.4\n% Dommus launch walkthrough document: use it wherever a PDF is asked for.\n%%EOF\n");
writeFileSync(`${DIR}/L7-id-card.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(512)]));

// Reconciliation at 31 October for the launch account.
const bankOct = closing; // every line is in October
const ledgerOct = opening - 20_000_000n + lodged - 10_500n;
const figures = {
  goLive: GO_LIVE,
  source: SOURCE,
  account: ACCOUNT,
  members: MEMBERS.map(({ name, pin, moaumId, role }) => ({ name, pin, moaumId, role })),
  legacy: legacyPlans.map((p) => ({ ...p, owed: naira(p.owed), first: naira(p.first), firstInterest: naira(p.firstInterest), firstPrincipal: naira(p.firstPrincipal) })),
  legacyTotal: naira(legacyTotal),
  october: { rows: OCT.length, total: naira(octTotal), totalPlain: plain(octTotal), lodged: naira(lodged), shortfall: naira(octTotal - lodged) },
  newLoan: { first: naira(newLoan.installments[0]!.amount), due: newLoan.installments[0]!.dueDate, interest: naira(newLoan.installments[0]!.interest) },
  statement: { from: "2026-10-02", to: "2026-11-03", opening: plain(opening), closing: plain(closing), closingNaira: naira(closing) },
  reconciliation: { bank: naira(bankOct), ledger: naira(ledgerOct), unapplied: naira(1_250_000n), difference: naira(bankOct - ledgerOct - 1_250_000n) },
};
writeFileSync(`${DIR}/figures.json`, JSON.stringify(figures, null, 2));
writeFileSync(
  `${DIR}/README.md`,
  [
    "# Launch walkthrough files (staging)",
    "",
    `Go-live ${GO_LIVE}, payroll source ${SOURCE}, bank account ${ACCOUNT}. Fictional people. Follow the launch walkthrough page; it says when to use each file.`,
    "",
    "| File | Step |",
    "|---|---|",
    "| L1-members.csv | Admin imports the members |",
    `| L2-legacy-loans.csv | Admin checks the legacy loans (total ${naira(legacyTotal)}, 3 loans) |`,
    `| L3-october-2026-salary-voucher.xlsx | Finance Manager's Source Advice (total ${naira(octTotal)}, ${OCT.length} members) |`,
    `| L4-october-2026-schedule.xlsx | Treasurer's October schedule (same total, ${OCT.length} rows, lodgement ${naira(lodged)}) |`,
    `| L5-union-bank-statement-2026-10-02-to-11-03.csv | Finance Manager imports it (opening ${plain(opening)}, closing ${plain(closing)}) |`,
    "| L6-document.pdf, L7-id-card.jpg | Any document or ID scan the steps ask for |",
    "",
  ].join("\n"),
);
console.log(JSON.stringify(figures, null, 2));
