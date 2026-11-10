/**
 * DEV ONLY. After rehearse-launch.mts: loads what every staff and member
 * screen reads, and builds every report (Excel and PDF), statement, payoff
 * quote and receipt from the rehearsal data, to catch anything that fails.
 * Run: npx --yes tsx@4.23.15 scripts/demo/check-screens.mts
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env.development.local"], quiet: true, override: true });
if (!/purple-river/.test(process.env.DATABASE_URL ?? "")) throw new Error("Not pointing at the dev branch; stopping.");
process.env.EVIDENCE_STORE = "local";
process.env.RECEIPT_SECRET ??= process.env.BETTER_AUTH_SECRET;

const { createClient } = await import("@/lib/db");
const { localDate } = await import("@/lib/dates");
const { ageingReport, cashierQueue, openTags, unmatchedLines } = await import("@/modules/credit/banking/matching");
const { bankOverview } = await import("@/modules/credit/banking/statements");
const { monthOverview, priorPeriodAdjustments } = await import("@/modules/credit/reconciliation/close");
const { listReclassifications } = await import("@/modules/credit/refunds/reclassifications");
const { creditMovements, listRefunds } = await import("@/modules/credit/refunds/refunds");
const { scheduleCorrections } = await import("@/modules/credit/remittance/corrections");
const { listSchedules } = await import("@/modules/credit/remittance/schedules");
const { listAdvices } = await import("@/modules/credit/remittance/source-advice");
const { DRILL_TYPES, drillDown, gmdDashboard } = await import("@/modules/credit/reports/dashboard");
const { loanStatementPdf, payoffQuotePdf, receiptPdf, receiptToken, verifyReceipt } = await import("@/modules/credit/reports/member-documents");
const { REPORTS, parsePeriod, reportPdf, reportXlsx } = await import("@/modules/credit/reports/staff-reports");
const { exposurePanel, listLoans, loanDetail } = await import("@/modules/credit/loans/queries");
const { listMembers } = await import("@/modules/credit/members/review");
const { listExceptions } = await import("@/shell/exceptions/exceptions");
const { settingsOverview } = await import("@/shell/settings/settings");

const db = createClient(process.env.DATABASE_URL as string);
let failed = 0;
async function check(what: string, run: () => Promise<unknown>) {
  try {
    const out = await run();
    const size = out instanceof Uint8Array ? `${out.length} bytes` : Array.isArray(out) ? `${out.length} rows` : "ok";
    console.log(`✓ ${what} (${size})`);
  } catch (error) {
    failed++;
    console.log(`✗ ${what}: ${(error as Error).message.split("\n")[0]}`);
  }
}

await check("Settings", () => settingsOverview(db));
await check("Members", () => listMembers(db, true));
await check("Loans list", () => listLoans(db, null));
await check("Bank overview", () => bankOverview(db));
await check("Bank matching: unmatched lines", () => unmatchedLines(db));
await check("Bank matching: open tags", () => openTags(db));
await check("Cashier queue", () => cashierQueue(db));
await check("Ageing", () => ageingReport(db));
await check("Remittance: advices", () => listAdvices(db));
await check("Remittance: schedules", () => listSchedules(db));
await check("Refunds", () => listRefunds(db));
await check("Reclassifications", () => listReclassifications(db));
await check("Reconciliation overview", () => monthOverview(db));
await check("Prior-period adjustments", () => priorPeriodAdjustments(db));
for (const status of ["ACTIVE", "CLOSED"] as const) await check(`Exceptions (${status})`, () => listExceptions(db, { status }));
await check("GMD dashboard", () => gmdDashboard(db));
for (const type of DRILL_TYPES) await check(`Dashboard drill-down ${type}`, () => drillDown(db, { type, from: localDate("2026-10-01"), to: localDate("2026-10-31") }));

for (const period of [parsePeriod("2026-10-01", "2026-10-31"), parsePeriod("2026-11-01", "2026-11-30")]) {
  for (const def of REPORTS) {
    await check(`Report ${def.key} ${period.from.slice(0, 7)}: Excel`, async () => reportXlsx(await def.build(db, period)));
    await check(`Report ${def.key} ${period.from.slice(0, 7)}: PDF`, async () => reportPdf(await def.build(db, period), def.landscape));
  }
}

const schedule = await db.remittanceSchedule.findFirstOrThrow({ where: { scheduleReference: "SCH-LAUNCH-OCT" }, include: { rows: true } });
await check("Schedule corrections", () => scheduleCorrections(db, schedule.id));
for (const row of schedule.rows) {
  await check(`Receipt PDF row ${row.rowNo}`, async () => (await receiptPdf(db, row.id)).bytes);
  await check(`Receipt check row ${row.rowNo}`, async () => {
    const result = await verifyReceipt(db, receiptToken(row.id));
    if (!result.genuine) throw new Error("receipt did not verify");
  });
}
const members = await db.member.findMany({ where: { moaumIdNumber: { startsWith: "MA-LAUNCH-" } }, include: { loans: true } });
for (const m of members) {
  await check(`Credit movements ${m.fullName}`, () => creditMovements(db, m.id));
  for (const loan of m.loans) {
    await check(`Loan detail ${loan.loanAccountNo}`, () => loanDetail(db, loan.id));
    await check(`Exposure ${loan.loanAccountNo}`, () => exposurePanel(db, loan.id));
    await check(`Loan statement PDF ${loan.loanAccountNo}`, async () => {
      const out = await loanStatementPdf(db, loan.id);
      return (out as { bytes?: Uint8Array }).bytes ?? out;
    });
    await check(`Payoff quote PDF ${loan.loanAccountNo}`, async () => {
      const out = await payoffQuotePdf(db, loan.id);
      return (out as { bytes?: Uint8Array }).bytes ?? out;
    });
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nEvery screen's data and every document built without error.");
await db.$disconnect();
process.exit(failed ? 1 : 0);
