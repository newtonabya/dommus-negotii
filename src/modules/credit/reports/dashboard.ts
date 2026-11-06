import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { addDays, daysBetween, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { ageingReport } from "../banking/matching";
import { ledgerPrincipalOutstanding } from "../loans/queries";

const toDb = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const sum = (values: bigint[]) => values.reduce((t, v) => t + v, 0n);

/** The last `n` months up to and including `asOf`'s, oldest first, as YYYY-MM. */
export function monthsBack(asOf: LocalDate, n: number): string[] {
  const [y, m] = asOf.split("-").map((x) => parseInt(x, 10)) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const k = y * 12 + (m - 1) - (n - 1 - i);
    return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
  });
}

/** Revenue is whatever the ledger recognised as revenue: INTEREST_INCOME net of reversals for Credit (PRD F14, AT-j). */
const REVENUE_WHERE = (moduleCode: string, from: Date, to: Date): Prisma.LedgerEventWhereInput => ({
  moduleCode,
  revenueAmount: { not: 0n },
  occurredAt: { gte: from, lte: to },
});

/** Bank interest credited by the bank: shown as Other bank credits, never revenue. */
const BANK_INTEREST_WHERE: Prisma.LedgerEventWhereInput = { eventType: "CASH_IN", metadata: { path: ["category"], equals: "BANK_INTEREST" } };

/**
 * The GMD's consolidated view (PRD F14), read straight from the ledger and
 * the bank records on every load. Read-only: nothing here writes.
 */
export async function gmdDashboard(db: Db, asOf: LocalDate = todayInLagos()) {
  const month = asOf.slice(0, 7);
  const monthStart = toDb(localDate(`${month}-01`));
  const yearStart = toDb(localDate(`${asOf.slice(0, 4)}-01-01`));
  const end = toDb(asOf);
  const months = monthsBack(asOf, 12);
  const windowStart = toDb(localDate(`${months[0]}-01`));

  const [accounts, cashByAccount, cashMonth, bankInterestMonth, ageing, liveRows, verifiedLodgements, schedules] = await Promise.all([
    db.bankAccount.findMany({ orderBy: [{ active: "desc" }, { bankName: "asc" }], include: { statements: { orderBy: { periodTo: "desc" }, take: 1 } } }),
    db.ledgerEvent.groupBy({
      by: ["bankAccountId", "eventType"],
      where: { bankAccountId: { not: null }, eventType: { in: ["OPENING_BALANCE", "CASH_IN", "CASH_OUT"] }, occurredAt: { lte: end } },
      _sum: { cashAmount: true },
    }),
    db.ledgerEvent.groupBy({ by: ["eventType"], where: { eventType: { in: ["CASH_IN", "CASH_OUT"] }, occurredAt: { gte: monthStart, lte: end } }, _sum: { cashAmount: true } }),
    db.ledgerEvent.aggregate({ where: { ...BANK_INTEREST_WHERE, occurredAt: { gte: monthStart, lte: end } }, _sum: { cashAmount: true } }),
    ageingReport(db, asOf),
    db.remittanceRow.groupBy({ by: ["scheduleId"], where: { reversedAt: null }, _sum: { amount: true } }),
    db.lodgement.groupBy({ by: ["scheduleId"], where: { scheduleId: { not: null }, status: { in: ["BANK_VERIFIED", "APPLIED"] } }, _sum: { amount: true } }),
    db.remittanceSchedule.findMany({ select: { id: true, scheduleReference: true, monthCovered: true, postedAt: true, remittanceSource: { select: { code: true } } } }),
  ]);

  // Cash position per account: the bank's latest closing balance beside the ledger's cash.
  const ledgerCash = new Map<string, bigint>();
  for (const g of cashByAccount) {
    const v = g._sum.cashAmount ?? 0n;
    ledgerCash.set(g.bankAccountId as string, (ledgerCash.get(g.bankAccountId as string) ?? 0n) + (g.eventType === "CASH_OUT" ? -v : v));
  }
  const bank = accounts.map((a) => ({
    id: a.id,
    label: `${a.bankName} ${a.accountNumber}`,
    active: a.active,
    statementBalance: a.statements[0]?.closingBalance ?? null,
    statementDate: a.statements[0] ? a.statements[0].periodTo.toISOString().slice(0, 10) : null,
    ledgerCash: ledgerCash.get(a.id) ?? 0n,
  }));
  const cashIn = cashMonth.find((g) => g.eventType === "CASH_IN")?._sum.cashAmount ?? 0n;
  const cashOut = cashMonth.find((g) => g.eventType === "CASH_OUT")?._sum.cashAmount ?? 0n;
  const otherBankCreditsMonth = bankInterestMonth._sum.cashAmount ?? 0n;

  // Track A: each schedule's total against the lodgements the bank has confirmed.
  const verified = new Map(verifiedLodgements.map((g) => [g.scheduleId as string, g._sum.amount ?? 0n]));
  const differences = schedules
    .map((s) => {
      const recorded = liveRows.find((r) => r.scheduleId === s.id)?._sum.amount ?? 0n;
      const paid = verified.get(s.id) ?? 0n;
      return { ...s, source: s.remittanceSource.code, recorded, paid, difference: recorded - paid };
    })
    .filter((s) => s.difference !== 0n)
    .sort((a, b) => (b.difference > a.difference ? 1 : -1));
  const recordedNotYetPaid = sum(differences.filter((d) => d.difference > 0n).map((d) => d.difference));
  const excess = sum(differences.filter((d) => d.difference < 0n).map((d) => -d.difference));

  // Revenue earned and other bank credits per month, last 12 months.
  const [revenueEvents, bankInterestEvents, rowsWindow, lodgementsWindow] = await Promise.all([
    db.ledgerEvent.findMany({ where: REVENUE_WHERE("CREDIT", windowStart, end), select: { occurredAt: true, revenueAmount: true } }),
    db.ledgerEvent.findMany({ where: { ...BANK_INTEREST_WHERE, occurredAt: { gte: windowStart, lte: end } }, select: { occurredAt: true, cashAmount: true } }),
    db.remittanceRow.findMany({ where: { reversedAt: null, paymentDate: { gte: windowStart, lte: end } }, select: { paymentDate: true, amount: true } }),
    db.lodgement.findMany({ where: { status: { in: ["BANK_VERIFIED", "APPLIED"] }, depositDate: { gte: windowStart, lte: end } }, select: { depositDate: true, amount: true } }),
  ]);
  const byMonth = <T>(items: T[], dateOf: (t: T) => Date, amountOf: (t: T) => bigint) => {
    const totals = new Map(months.map((m) => [m, 0n]));
    for (const i of items) {
      const m = monthOf(dateOf(i));
      if (totals.has(m)) totals.set(m, (totals.get(m) ?? 0n) + amountOf(i));
    }
    return months.map((m) => ({ month: m, amount: totals.get(m) ?? 0n }));
  };
  const revenue = byMonth(revenueEvents, (e) => e.occurredAt, (e) => e.revenueAmount);
  const otherBankCredits = byMonth(bankInterestEvents, (e) => e.occurredAt, (e) => e.cashAmount);
  const repayments = byMonth(rowsWindow, (r) => r.paymentDate, (r) => r.amount);
  const lodged = byMonth(lodgementsWindow, (l) => l.depositDate, (l) => l.amount);
  const revenueYtd = sum(revenueEvents.filter((e) => e.occurredAt >= yearStart).map((e) => e.revenueAmount));

  // Credit module figures (the only module in Phase 1).
  const [activeLoans, activeMembers, disbursedYtd, credits, modules, exceptions] = await Promise.all([
    db.loan.findMany({ where: { status: "ACTIVE" }, select: { id: true } }),
    db.member.count({ where: { status: "ACTIVE" } }),
    db.ledgerEvent.aggregate({ where: { eventType: "CASH_OUT", source: "DISBURSEMENT_VOUCHER", occurredAt: { gte: yearStart, lte: end } }, _sum: { cashAmount: true } }),
    db.ledgerEvent.groupBy({ by: ["eventType"], where: { eventType: { in: ["DEPOSIT_CREDITED", "DEPOSIT_REFUNDED"] }, occurredAt: { lte: end } }, _sum: { depositDelta: true } }),
    db.module.findMany({ orderBy: { registeredAt: "asc" }, select: { code: true, name: true, status: true } }),
    db.exceptionRecord.findMany({ where: { status: { not: "CLOSED" } }, select: { type: true, status: true, amount: true, raisedAt: true } }),
  ]);
  const outstanding = await ledgerPrincipalOutstanding(db, activeLoans.map((l) => l.id));
  const creditDeposits = credits.reduce((t, g) => t + (g.eventType === "DEPOSIT_REFUNDED" ? -(g._sum.depositDelta ?? 0n) : (g._sum.depositDelta ?? 0n)), 0n);

  const exceptionTypes = new Map<string, { type: string; open: number; underReview: number; amount: bigint; oldestDays: number }>();
  for (const e of exceptions) {
    const row = exceptionTypes.get(e.type) ?? { type: e.type, open: 0, underReview: 0, amount: 0n, oldestDays: 0 };
    if (e.status === "OPEN") row.open++;
    else row.underReview++;
    row.amount += e.amount ?? 0n;
    row.oldestDays = Math.max(row.oldestDays, daysBetween(localDate(e.raisedAt.toISOString().slice(0, 10)), asOf));
    exceptionTypes.set(e.type, row);
  }

  return {
    asOf,
    month,
    cash: {
      accounts: bank,
      statementTotal: sum(bank.map((b) => b.statementBalance ?? 0n)),
      ledgerTotal: sum(bank.map((b) => b.ledgerCash)),
      cashInMonth: cashIn,
      cashOutMonth: cashOut,
      otherBankCreditsMonth,
      unappliedBankCredits: ageing.unappliedCredits.total,
      unverifiedLodgements: ageing.unverifiedLodgements.total,
      recordedNotYetPaid,
      excess,
      differences: differences.slice(0, 20),
    },
    revenue: { months: revenue, ytd: revenueYtd, otherBankCredits },
    trends: { repayments, lodged },
    credit: {
      activeLoans: activeLoans.length,
      outstandingPrincipal: sum([...outstanding.values()]),
      activeMembers,
      disbursedYtd: disbursedYtd._sum.cashAmount ?? 0n,
      overpaymentCredits: creditDeposits,
      revenueYtd,
    },
    modules,
    exceptions: { byType: [...exceptionTypes.values()].sort((a, b) => b.oldestDays - a.oldestDays), total: exceptions.length },
  };
}

export const DRILL_TYPES = ["CASH_IN", "CASH_OUT", "OPENING_BALANCE", "INTEREST_INCOME", "BANK_INTEREST", "REVENUE"] as const;
export type DrillType = (typeof DRILL_TYPES)[number];

/** The transactions behind a dashboard figure, each with its evidence (PRD F14 drill-down). */
export async function drillDown(db: Db, input: { type: DrillType; from: LocalDate; to: LocalDate; bankAccountId?: string | null }) {
  const range = { gte: toDb(input.from), lte: toDb(input.to) };
  const where: Prisma.LedgerEventWhereInput =
    input.type === "REVENUE"
      ? REVENUE_WHERE("CREDIT", range.gte, range.lte)
      : input.type === "BANK_INTEREST"
        ? { ...BANK_INTEREST_WHERE, occurredAt: range }
        : { eventType: input.type, occurredAt: range };
  if (input.bankAccountId) where.bankAccountId = input.bankAccountId;
  return db.ledgerEvent.findMany({ where, orderBy: [{ occurredAt: "desc" }, { postedAt: "desc" }], take: 300 });
}

/** First and last day of a YYYY-MM month. */
export function monthRange(month: string): { from: LocalDate; to: LocalDate } {
  const from = localDate(`${month}-01`);
  const [y, m] = month.split("-").map((x) => parseInt(x, 10)) as [number, number];
  return { from, to: addDays(localDate(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`), -1) };
}
