/**
 * DEV ONLY. After rehearse-launch.mts: rehearses the walkthrough's November
 * payroll (L6, Phase 8) on the dev database, calling the same functions the
 * screens call, and checks the figures the page quotes (figures.json →
 * "november"): Bem's overpayment lowers his later instalments, Kelechi's
 * shortfall stays due, Comfort's loan closes, and the December deduction
 * schedule follows. One pass: it stops if SCH-LAUNCH-NOV already exists.
 * Run: npx --yes tsx@4.23.15 scripts/demo/rehearse-november.mts
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: [".env.local", ".env.development.local"], quiet: true, override: true });
if (!/purple-river/.test(process.env.DATABASE_URL ?? "")) throw new Error("Not pointing at the dev branch; stopping.");
process.env.EVIDENCE_STORE = "local";
delete process.env.APP_STAGE;

const { createClient } = await import("@/lib/db");
const { formatNaira, kobo } = await import("@/lib/money");
const { getEvidenceStore } = await import("@/evidence/store");
const { commitSchedule, previewSchedule } = await import("@/modules/credit/remittance/schedules");
const { loanLiveState } = await import("@/modules/credit/loans/repayments");
const { deductionSchedule } = await import("@/modules/credit/reports/deduction-schedule");

const db = createClient(process.env.DATABASE_URL as string);
const DIR = "docs/launch-files";
const figures = JSON.parse(readFileSync(`${DIR}/figures.json`, "utf8")).november;
const naira = (k: bigint) => formatNaira(kobo(k));
const treasurer = { id: "rehearsal-treasurer", ipAddress: "127.0.0.1" };
const problems: string[] = [];
const expectEq = (what: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✓" : "✗"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (page says ${JSON.stringify(want)})`}`);
  if (!ok) problems.push(what);
};

if (await db.remittanceSchedule.findFirst({ where: { scheduleReference: "SCH-LAUNCH-NOV" } })) throw new Error("SCH-LAUNCH-NOV is already posted on dev; stopping.");
const source = await db.remittanceSource.findFirstOrThrow({ where: { code: "LAUNCH-PAYROLL" } });

console.log("Treasurer posts the November schedule (L6)");
const preview = await previewSchedule(
  db,
  getEvidenceStore(),
  treasurer,
  { scheduleReference: "SCH-LAUNCH-NOV", remittanceSource: "LAUNCH-PAYROLL", monthCovered: "2026-11", scheduleType: "REGULAR", adviceReference: "", submittedBy: "Treasurer", controlTotal: figures.totalPlain, rowCount: String(figures.rows) },
  { filename: "L6-november-2026-schedule.xlsx", bytes: new Uint8Array(readFileSync(`${DIR}/L6-november-2026-schedule.xlsx`)) },
);
await commitSchedule(db, treasurer, preview.batchId);

for (const p of figures.people) {
  const member = await db.member.findFirstOrThrow({ where: { payrollStaffNo: p.pin, remittanceSourceId: source.id } });
  const loan = await db.loan.findFirstOrThrow({ where: { memberId: member.id, status: { in: ["ACTIVE", "CLOSED"] } }, orderBy: { createdAt: "desc" } });
  const live = await loanLiveState(db, loan, figures.asOf);
  console.log(p.name);
  expectEq("status", live?.state.status, p.status);
  expectEq("principal left", naira(live!.state.outstandingPrincipal), p.balanceAfter);
  expectEq("next payment", live?.next ? { amount: naira(live.next.amount), due: live.next.dueDate, overdue: naira(live.next.overdue) } : null, p.next);
  expectEq("left to pay", live?.remaining.map((r) => `${r.dueDate} ${naira(r.amount)}${r.overdue ? " overdue" : ""}`), p.left);
}

console.log("Treasurer produces December's deduction schedule");
const schedule = await deductionSchedule(db, source.id, "2026-12", figures.asOf);
const launch = schedule.members.filter((m) => figures.people.some((p: { pin: string }) => p.pin === m.staffNo));
for (const p of figures.people) expectEq(`${p.name} in December`, launch.find((m) => m.staffNo === p.pin) ? naira(launch.find((m) => m.staffNo === p.pin)!.thisMonth) : null, p.december);
expectEq("launch rows", schedule.rows.filter((r) => figures.people.some((p: { pin: string }) => p.pin === r.staffNo)).length, figures.decemberRows);
expectEq("Comfort listed as stopped", schedule.stopped.some((s) => s.staffNo === "LP1003"), true);

console.log(problems.length ? `\nDIFFERENCES FROM THE PAGE (${problems.length}): ${problems.join(", ")}` : "\nEverything matched the page.");
await db.$disconnect();
