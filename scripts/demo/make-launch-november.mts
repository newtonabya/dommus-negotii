/**
 * Writes L6, the November payroll for the launch walkthrough (Phase 8), and
 * the figures the page quotes for it (figures.json → "november"), computed
 * with the app's own loan engine. Bem pays ₦60,000 more than asked, Kelechi
 * less than his overdue instalment, Adaeze exactly what was asked, and Comfort
 * her last instalment. Safe to run again: it touches only L6 and its figures.
 * Run: npx --yes tsx@4.23.15 scripts/demo/make-launch-november.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";

const { localDate } = await import("@/lib/dates");
const { bps, kobo, formatNaira } = await import("@/lib/money");
const { computeLoanState } = await import("@/modules/credit/domain/recompute");
const { nextPayment, remainingInstalments } = await import("@/modules/credit/domain/projection");

const DIR = "docs/launch-files";
const ACCOUNT = "3099100001";
const PAID_ON = "2026-11-13";
/** The figures hold for any day from the payment to 30 November (the next instalments fall due from 1 December). */
const AS_OF = "2026-11-20";
const naira = (k: bigint) => formatNaira(kobo(k));
const plain = (k: bigint) => `${k / 100n}.${String(k % 100n).padStart(2, "0")}`;
const rate = bps(750n);

const LOANS = [
  { name: "Adaeze Okoro", pin: "LP1001", principal: 15_000_000n, tenure: 3, d0: "2026-10-01", october: 6_125_000n, november: 5_750_000n, asked: 5_750_000n },
  // Bem pays ₦60,000 more than the ₦73,500 asked: the overpayment.
  { name: "Bem Tyokaa", pin: "LP1002", principal: 24_000_000n, tenure: 4, d0: "2026-10-01", october: 7_800_000n, november: 13_350_000n, asked: 7_350_000n },
  { name: "Comfort Agbo", pin: "LP1003", principal: 9_000_000n, tenure: 2, d0: "2026-10-01", october: 5_175_000n, november: 4_837_500n, asked: 4_837_500n },
  // Kelechi pays ₦30,000 of the ₦96,666.66 asked: a shortfall.
  { name: "Kelechi Obi", pin: "LP1005", principal: 20_000_000n, tenure: 6, d0: "2026-10-03", october: 0n, november: 3_000_000n, asked: 9_666_666n },
];

const pays = (l: (typeof LOANS)[number], withNovember: boolean) => [
  ...(l.october ? [{ id: "oct", date: localDate("2026-10-28"), amount: kobo(l.october), order: "1" }] : []),
  ...(withNovember ? [{ id: "nov", date: localDate(PAID_ON), amount: kobo(l.november), order: "2" }] : []),
];

const people = LOANS.map((l) => {
  const terms = { principal: kobo(l.principal), tenure: l.tenure, rate, d0: localDate(l.d0) };
  const before = computeLoanState(terms, pays(l, false), localDate(AS_OF));
  const after = computeLoanState(terms, pays(l, true), localDate(AS_OF));
  const rows = remainingInstalments(after, rate, localDate(AS_OF));
  const next = nextPayment(rows, after);
  const beforeRows = remainingInstalments(before, rate, localDate(AS_OF));
  const reached = new Set(after.installments.map((i) => i.k));
  return {
    name: l.name,
    pin: l.pin,
    asked: naira(l.asked),
    paid: naira(l.november),
    balanceBefore: naira(before.outstandingPrincipal),
    balanceAfter: naira(after.outstandingPrincipal),
    status: after.status,
    next: next ? { amount: naira(next.amount), due: next.dueDate, overdue: naira(next.overdue) } : null,
    left: rows.map((r) => `${r.dueDate} ${naira(r.amount)}${r.overdue ? " overdue" : ""}`),
    leftBefore: beforeRows.map((r) => `${r.dueDate} ${naira(r.amount)}${r.overdue ? " overdue" : ""}`),
    // The December deduction: everything already due, or else the next instalment.
    december: next ? naira(next.amount) : null,
    months: next ? rows.filter((r) => !reached.has(r.k)).length + (rows.some((r) => reached.has(r.k)) ? 1 : 0) : 0,
  };
});

const total = LOANS.reduce((t, l) => t + l.november, 0n);
{
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Rows");
  sheet.addRow(["row_type", "pin", "member_name", "loan_account_no", "amount_paid", "payment_date", "period_covered", "receipt_no", "bank_credit_ref", "row_note"]);
  for (const l of LOANS) sheet.addRow(["PAYROLL", l.pin, l.name, "", plain(l.november), PAID_ON, "November 2026", "", "", ""]);
  const lodge = wb.addWorksheet("Lodgements");
  lodge.addRow(["bank_account", "deposit_date", "reference", "amount", "depositor", "note"]);
  lodge.addRow([ACCOUNT, "2026-11-14", "SLIP-LP-1114", plain(total), "Bursary", "November deductions"]);
  await wb.xlsx.writeFile(`${DIR}/L6-november-2026-schedule.xlsx`);
}

const figuresPath = `${DIR}/figures.json`;
const figures = JSON.parse(readFileSync(figuresPath, "utf8"));
figures.november = { paidOn: PAID_ON, rows: LOANS.length, total: naira(total), totalPlain: plain(total), lodgement: "SLIP-LP-1114", asOf: AS_OF, people, decemberRows: people.reduce((t, p) => t + p.months, 0) };
writeFileSync(figuresPath, JSON.stringify(figures, null, 2));

const readmePath = `${DIR}/README.md`;
const readme = readFileSync(readmePath, "utf8");
const line = `| L6-november-2026-schedule.xlsx | Treasurer's November schedule (${LOANS.length} rows, total ${naira(total)}): Bem overpays, Kelechi underpays |`;
if (!readme.includes("L6-november")) writeFileSync(readmePath, readme.replace(/(\| L5-[^\n]*\n)/, `$1${line}\n`));
console.log(JSON.stringify(figures.november, null, 2));
