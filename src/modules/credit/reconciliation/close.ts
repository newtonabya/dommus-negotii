import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { compareDates, todayInLagos, type LocalDate } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { PdfWriter } from "@/lib/pdf";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { writeAudit } from "@/shell/audit/audit";
import { reportByKey, reportPdf } from "../reports/staff-reports";
export { priorPeriodAdjustments } from "./adjustments";
import { ITEM_LABEL, latestRun, monthBounds, ReconciliationError, type ReconActor, type StoredResults } from "./reconciliation";

/**
 * Month close (PRD F11): after the month's reconciliation the Finance Manager
 * closes it. The month's reports are saved as PDFs (evidence) and its ledger
 * totals are recorded. Months close in order and never reopen; anything
 * posted later with a date inside a closed month is a prior-period adjustment
 * of the next open month.
 */
const toDb = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const naira = (v: string | bigint) => formatNaira(kobo(BigInt(v)));
export const SNAPSHOT_REPORTS = ["interest-income", "collections", "track-a", "overpayment-credits", "unapplied-credits", "unverified-lodgements"] as const;

const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map((x) => parseInt(x, 10)) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** The month that must close next: the one after the last closed, or the first month with any ledger activity. */
export async function nextMonthToClose(db: Db): Promise<string | null> {
  const last = await db.periodClose.findFirst({ orderBy: { month: "desc" } });
  if (last) return nextMonth(last.month);
  const first = await db.ledgerEvent.findFirst({ orderBy: { occurredAt: "asc" }, select: { occurredAt: true } });
  return first ? first.occurredAt.toISOString().slice(0, 7) : null;
}

/** Ledger totals for events dated inside the month, per event type and money field. */
export async function monthLedgerTotals(db: Db, month: string) {
  const { start, end } = monthBounds(month);
  const groups = await db.ledgerEvent.groupBy({
    by: ["eventType"],
    where: { occurredAt: { gte: toDb(start), lte: toDb(end) } },
    _sum: { cashAmount: true, revenueAmount: true, depositDelta: true, principalAmount: true, interestAmount: true },
    _count: { _all: true },
  });
  return Object.fromEntries(
    groups.map((g) => [
      g.eventType,
      {
        count: g._count._all,
        cash: (g._sum.cashAmount ?? 0n).toString(),
        revenue: (g._sum.revenueAmount ?? 0n).toString(),
        deposit: (g._sum.depositDelta ?? 0n).toString(),
        principal: (g._sum.principalAmount ?? 0n).toString(),
        interest: (g._sum.interestAmount ?? 0n).toString(),
      },
    ]),
  );
}

/** The reconciliation run as a PDF for the month's snapshot. */
async function reconciliationPdf(results: StoredResults) {
  const pdf = await PdfWriter.create(`Reconciliation ${results.month}`, "Dommus Negotii · MOAUM Credit Super Store", { landscape: true });
  pdf.title(`Joint reconciliation, ${results.month}`, `At ${results.end}`);
  for (const a of results.accounts) {
    pdf.heading(a.label);
    pdf.table(
      [
        { header: "", width: 4 },
        { header: "Amount", width: 1.4, align: "right" },
      ],
      [
        ["Statement balance", naira(a.bank)],
        ["Ledger cash", naira(a.ledger)],
        ...a.items.map((i) => [`${ITEM_LABEL[i.kind]}: ${i.label} (${i.date})`, naira(i.amount)]),
        ["Difference left", naira(a.residual)],
      ],
      { totalRow: true },
    );
  }
  pdf.heading("Repayments against the bank (all schedules to the month)");
  pdf.facts([
    ["Repayments recorded", naira(results.trackA.recorded)],
    ["Bank-verified lodgements", naira(results.trackA.verified)],
    ["Recorded, not yet paid", naira(results.trackA.notYetPaid)],
    ["Excess", naira(results.trackA.excess)],
    ["Equation holds", results.trackA.holds ? "Yes" : "No"],
  ]);
  return pdf.bytes();
}

/**
 * The Finance Manager closes a month: in order, after it has ended, with a
 * reconciliation run for it. Saves the report snapshots as evidence.
 */
export async function closeMonth(db: Db, store: EvidenceStore, actor: ReconActor, month: string, today: LocalDate = todayInLagos()) {
  const { start, end } = monthBounds(month);
  if (compareDates(end, today) >= 0) throw new ReconciliationError(`${month} hasn't ended yet.`);
  if (await db.periodClose.findUnique({ where: { month } })) throw new ReconciliationError(`${month} is already closed. A closed month is never reopened.`);
  const due = await nextMonthToClose(db);
  if (due && month !== due) throw new ReconciliationError(`Months close in order: close ${due} first.`);
  const run = await latestRun(db, month);
  if (!run) throw new ReconciliationError(`Run the reconciliation for ${month} first.`);

  const snapshots: Array<{ key: string; title: string; evidenceId: string }> = [];
  const period = { from: start, to: end };
  const recon = await storeEvidenceBytes(db, store, actor, `month-close-${month}-reconciliation.pdf`, await reconciliationPdf(run.results));
  snapshots.push({ key: "reconciliation", title: "Joint reconciliation", evidenceId: recon.evidenceId });
  for (const key of SNAPSHOT_REPORTS) {
    const def = reportByKey(key);
    if (!def) continue;
    const report = await def.build(db, period);
    const file = await storeEvidenceBytes(db, store, actor, `month-close-${month}-${key}.pdf`, await reportPdf({ ...report, subtitle: `${report.subtitle} · snapshot at month close` }, def.landscape));
    snapshots.push({ key, title: def.title, evidenceId: file.evidenceId });
  }
  const ledgerTotals = await monthLedgerTotals(db, month);
  const closed = await db.periodClose.create({ data: { month, runId: run.id, closedById: actor.id, snapshots: snapshots as unknown as Prisma.InputJsonValue, ledgerTotals: ledgerTotals as Prisma.InputJsonValue } });
  for (const s of snapshots) {
    await linkEvidence(db, actor, { evidenceId: s.evidenceId, entityType: "PeriodClose", entityId: month, kind: "PRIMARY", submissionKey: `MONTH_CLOSE:${month}` });
  }
  await writeAudit(db, { action: "month.close", entityType: "PeriodClose", entityId: month, userId: actor.id, ipAddress: actor.ipAddress, after: { runId: run.id, snapshots: snapshots.length } });
  return closed;
}

/** Months for the page: closed ones with their snapshots, and the one due next. */
export async function monthOverview(db: Db) {
  const [closes, due] = await Promise.all([db.periodClose.findMany({ orderBy: { month: "desc" }, take: 24 }), nextMonthToClose(db)]);
  return { closes: closes.map((c) => ({ ...c, snapshots: c.snapshots as unknown as Array<{ key: string; title: string; evidenceId: string }> })), due };
}
