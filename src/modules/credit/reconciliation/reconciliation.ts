import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { addDays, compareDates, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { writeAudit } from "@/shell/audit/audit";
import { raiseException, refreshException } from "@/shell/exceptions/exceptions";

/**
 * Monthly reconciliation (PRD F11), run by the Finance Manager once every
 * account's statements cover the month plus 3 days:
 *  - Track A: each posted schedule against its bank-verified lodgements
 *    (SHORTFALL / EXCESS against the source). Loan balances never change.
 *  - Track B: statement lines against lodgements, tags, vouchers and entries
 *    (IN_BANK_NOT_IN_SYSTEM, IN_SYSTEM_NOT_IN_BANK, AMOUNT_MISMATCH, DUPLICATE).
 *  - Equation (1), per account at month end: bank = ledger cash + reconciling
 *    items; any remainder raises LEDGER_BANK_DIFFERENCE.
 *  - Equation (2): repayments recorded = verified lodgements + recorded, not
 *    yet paid − excess.
 */
export class ReconciliationError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ReconciliationError";
  }
}

/**
 * Limits a run to some bank accounts and remittance sources. Only tests pass
 * it (the shared test database holds every other test's data); the app always
 * reconciles everything.
 */
export interface ReconScope {
  bankAccountIds?: string[];
  sourceIds?: string[];
}

export interface ReconActor {
  id: string;
  ipAddress: string | null;
}

export const STATEMENT_MARGIN_DAYS = 3;
const toDb = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => localDate(d.toISOString().slice(0, 10));
const naira = (v: bigint) => formatNaira(kobo(v));

export function monthBounds(month: string): { start: LocalDate; end: LocalDate } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ReconciliationError("Choose a month (YYYY-MM).");
  const [y, m] = month.split("-").map((x) => parseInt(x, 10)) as [number, number];
  const start = localDate(`${month}-01`);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(localDate(next), -1) };
}

export type ItemKind =
  | "UNAPPLIED_CREDIT"
  | "TAGGED_NOT_SCHEDULED"
  | "VERIFIED_NOT_RECORDED"
  | "DEBIT_NOT_RECORDED"
  | "RECORDED_DEBIT_NOT_ON_STATEMENT"
  | "RECORDED_CREDIT_NOT_ON_STATEMENT";

export const ITEM_LABEL: Record<ItemKind, string> = {
  UNAPPLIED_CREDIT: "+ Unapplied Bank Credits",
  TAGGED_NOT_SCHEDULED: "+ Tagged direct payments not yet on a posted schedule",
  VERIFIED_NOT_RECORDED: "+ BANK_VERIFIED lodgements not yet recorded by the Cashier",
  DEBIT_NOT_RECORDED: "− Statement debits not yet recorded",
  RECORDED_DEBIT_NOT_ON_STATEMENT: "+ Recorded debits not yet on the statement",
  RECORDED_CREDIT_NOT_ON_STATEMENT: "− Recorded credits not yet on the statement",
};

export interface ReconItem {
  kind: ItemKind;
  /** Signed effect on the equation, in kobo. */
  amount: bigint;
  date: string;
  label: string;
  ref: string;
}

/**
 * Equation (1) for one account at `end`: the bank balance (go-live opening +
 * every imported line up to `end`) against ledger cash (OPENING_BALANCE +
 * CASH_IN − CASH_OUT up to `end`), with every line or ledger event that is on
 * one side only listed as a reconciling item.
 */
export async function accountPosition(db: Db, bankAccountId: string, end: LocalDate) {
  const opening = await db.bankOpeningBalance.findFirst({ where: { bankAccountId, status: "COMMITTED" } });
  if (!opening || compareDates(day(opening.asOf), end) > 0) return null;
  const [lines, events] = await Promise.all([
    db.bankStatementLine.findMany({
      where: { bankAccountId, transactionDate: { lte: toDb(end) } },
      include: { tag: true, entry: true, lodgement: true },
      orderBy: { transactionDate: "asc" },
    }),
    db.ledgerEvent.findMany({ where: { bankAccountId, eventType: { in: ["OPENING_BALANCE", "CASH_IN", "CASH_OUT"] }, occurredAt: { lte: toDb(end) } } }),
  ]);

  // Which statement line does each cash event belong to?
  const lodgementIds = events.filter((e) => e.moduleEntityType === "Lodgement").map((e) => e.moduleEntityId);
  const entryIds = events.filter((e) => e.moduleEntityType === "BankLineEntry").map((e) => e.moduleEntityId);
  const voucherIds = events.flatMap((e) => (e.eventType === "CASH_OUT" && (e.metadata as { voucherId?: string }).voucherId ? [(e.metadata as { voucherId: string }).voucherId] : []));
  const [lodgementLines, entryLines, voucherLines] = await Promise.all([
    db.bankStatementLine.findMany({ where: { lodgementId: { in: lodgementIds } }, select: { id: true, lodgementId: true, transactionDate: true } }),
    db.bankLineEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, line: { select: { id: true, transactionDate: true } } } }),
    db.bankStatementLine.findMany({ where: { voucherId: { in: voucherIds } }, select: { id: true, voucherId: true, transactionDate: true } }),
  ]);
  const lineOf = new Map<string, { id: string; date: Date }>();
  for (const l of lodgementLines) if (l.lodgementId) lineOf.set(`Lodgement:${l.lodgementId}`, { id: l.id, date: l.transactionDate });
  for (const e of entryLines) lineOf.set(`BankLineEntry:${e.id}`, { id: e.line.id, date: e.line.transactionDate });
  for (const v of voucherLines) if (v.voucherId) lineOf.set(`Voucher:${v.voucherId}`, { id: v.id, date: v.transactionDate });
  const eventLine = (e: (typeof events)[number]) => {
    const voucherId = (e.metadata as { voucherId?: string }).voucherId;
    return e.moduleEntityType === "Lodgement" || e.moduleEntityType === "BankLineEntry" ? lineOf.get(`${e.moduleEntityType}:${e.moduleEntityId}`) : voucherId ? lineOf.get(`Voucher:${voucherId}`) : undefined;
  };

  let ledger = 0n;
  const linesInLedger = new Set<string>();
  const items: ReconItem[] = [];
  for (const e of events) {
    const signed = e.eventType === "CASH_OUT" ? -e.cashAmount : e.cashAmount;
    ledger += signed;
    if (e.eventType === "OPENING_BALANCE") continue;
    const line = eventLine(e);
    if (line && compareDates(day(line.date), end) <= 0) linesInLedger.add(line.id);
    else {
      items.push({
        kind: signed < 0n ? "RECORDED_DEBIT_NOT_ON_STATEMENT" : "RECORDED_CREDIT_NOT_ON_STATEMENT",
        amount: -signed,
        date: day(e.occurredAt),
        label: `${e.eventType === "CASH_OUT" ? "Paid out" : "Recorded"} ${naira(signed < 0n ? -signed : signed)} (${e.source.replaceAll("_", " ").toLowerCase()})`,
        ref: `event:${e.id}`,
      });
    }
  }

  let bank = opening.amount;
  for (const l of lines) {
    const signed = l.direction === "CREDIT" ? l.amount : -l.amount;
    if (compareDates(day(l.transactionDate), day(opening.asOf)) <= 0) continue;
    bank += signed;
    if (linesInLedger.has(l.id)) continue;
    const kind: ItemKind =
      l.direction === "DEBIT"
        ? "DEBIT_NOT_RECORDED"
        : l.lodgement?.status === "BANK_VERIFIED"
          ? "VERIFIED_NOT_RECORDED"
          : l.tag && !l.tag.lodgementId
            ? "TAGGED_NOT_SCHEDULED"
            : "UNAPPLIED_CREDIT";
    items.push({ kind, amount: signed, date: day(l.transactionDate), label: `${l.narration}${l.reference ? ` · ${l.reference}` : ""}`, ref: `line:${l.id}` });
  }
  const explained = items.reduce((t, i) => t + i.amount, 0n);
  return { bank, ledger, items, residual: bank - (ledger + explained) };
}

/** Each schedule up to the month: recorded (live rows) against bank-verified lodgements. */
export async function trackA(db: Db, month: string, scope: ReconScope = {}) {
  const schedules = await db.remittanceSchedule.findMany({
    where: { monthCovered: { lte: month }, ...(scope.sourceIds ? { remittanceSourceId: { in: scope.sourceIds } } : {}) },
    include: { remittanceSource: { select: { code: true } }, rows: { where: { reversedAt: null }, select: { amount: true } }, lodgements: { select: { amount: true, status: true } } },
    orderBy: [{ monthCovered: "asc" }, { postedAt: "asc" }],
  });
  return schedules.map((s) => {
    const recorded = s.rows.reduce((t, r) => t + r.amount, 0n);
    const verified = s.lodgements.filter((l) => l.status !== "UNVERIFIED").reduce((t, l) => t + l.amount, 0n);
    return { id: s.id, reference: s.scheduleReference, source: s.remittanceSource.code, sourceId: s.remittanceSourceId, monthCovered: s.monthCovered, recorded, verified, difference: recorded - verified };
  });
}

/** Keeps a schedule's SHORTFALL/EXCESS exception in step with its lodgements; never raises one outside a run. */
export async function refreshScheduleException(db: Db, scheduleId: string) {
  const s = await db.remittanceSchedule.findUnique({ where: { id: scheduleId }, select: { monthCovered: true } });
  if (!s) return;
  const row = (await trackA(db, s.monthCovered)).find((r) => r.id === scheduleId);
  if (!row) return;
  for (const type of ["SHORTFALL", "EXCESS"] as const) {
    const amount = type === "SHORTFALL" ? (row.difference > 0n ? row.difference : 0n) : row.difference < 0n ? -row.difference : 0n;
    await refreshException(db, `${type}:${scheduleId}`, { amount, details: { readyToClose: amount === 0n, recorded: row.recorded.toString(), verified: row.verified.toString() } });
  }
}

interface ExceptionPlan {
  type: string;
  dedupeKey: string;
  title: string;
  amount: bigint;
  details: Record<string, unknown>;
}

/** The Track B items that become exceptions for lines and records up to `end`. */
async function trackBExceptions(db: Db, month: string, end: LocalDate, scope: ReconScope): Promise<ExceptionPlan[]> {
  const out: ExceptionPlan[] = [];
  const inScope = scope.bankAccountIds ? { bankAccountId: { in: scope.bankAccountIds } } : {};
  const [lines, lodgements, vouchers] = await Promise.all([
    db.bankStatementLine.findMany({ where: { transactionDate: { lte: toDb(end) }, ...inScope }, include: { tag: true, entry: true, bankAccount: { select: { accountNumber: true } } } }),
    db.lodgement.findMany({ where: { status: "UNVERIFIED", depositDate: { lte: toDb(end) }, statementLine: { is: null }, ...inScope }, include: { schedule: { select: { scheduleReference: true } } } }),
    db.voucher.findMany({ where: { status: "VERIFIED", valueDate: { lte: toDb(end) }, statementLine: { is: null }, ...inScope } }),
  ]);
  for (const l of lines) {
    const date = day(l.transactionDate);
    if (l.uniquenessKey.includes("#")) {
      out.push({ type: "DUPLICATE", dedupeKey: `DUPLICATE:line:${l.id}`, title: `A statement line appears twice: ${naira(l.amount)} on ${date} (${l.narration})`, amount: l.amount, details: { month, lineId: l.id, account: l.bankAccount.accountNumber } });
    }
    const matched = l.lodgementId || l.voucherId || l.tag || l.entry?.status === "VERIFIED";
    if (matched) continue;
    const ref = l.reference.trim().toUpperCase();
    const mismatch =
      ref &&
      (l.direction === "CREDIT"
        ? lodgements.find((g) => g.bankAccountId === l.bankAccountId && g.reference.toUpperCase() === ref && g.amount !== l.amount)
        : vouchers.find((v) => v.bankAccountId === l.bankAccountId && v.transferRef.toUpperCase() === ref && v.amount !== l.amount));
    if (mismatch) {
      out.push({
        type: "AMOUNT_MISMATCH",
        dedupeKey: `AMOUNT_MISMATCH:line:${l.id}`,
        title: `Reference ${l.reference} matches but the amounts differ: bank ${naira(l.amount)}, records ${naira(mismatch.amount)}`,
        amount: l.amount > mismatch.amount ? l.amount - mismatch.amount : mismatch.amount - l.amount,
        details: { month, lineId: l.id, recordId: mismatch.id, account: l.bankAccount.accountNumber },
      });
      continue;
    }
    out.push({
      type: "IN_BANK_NOT_IN_SYSTEM",
      dedupeKey: `IN_BANK_NOT_IN_SYSTEM:line:${l.id}`,
      title: `${l.direction === "CREDIT" ? "Unapplied bank credit" : "Unrecorded bank debit"} ${naira(l.amount)} on ${date}: ${l.narration}`,
      amount: l.amount,
      details: { month, lineId: l.id, direction: l.direction, account: l.bankAccount.accountNumber, date },
    });
  }
  for (const g of lodgements) {
    out.push({
      type: "IN_SYSTEM_NOT_IN_BANK",
      dedupeKey: `IN_SYSTEM_NOT_IN_BANK:lodgement:${g.id}`,
      title: `Unverified lodgement ${naira(g.amount)} (${g.reference}, ${day(g.depositDate)}) on schedule ${g.schedule?.scheduleReference ?? "-"}: not seen at the bank`,
      amount: g.amount,
      details: { month, lodgementId: g.id },
    });
  }
  for (const v of vouchers) {
    out.push({
      type: "IN_SYSTEM_NOT_IN_BANK",
      dedupeKey: `IN_SYSTEM_NOT_IN_BANK:voucher:${v.id}`,
      title: `Verified ${v.type.toLowerCase()} voucher ${naira(v.amount)} (${v.transferRef}, ${day(v.valueDate)}): no statement debit matched`,
      amount: v.amount,
      details: { month, voucherId: v.id },
    });
  }
  return out;
}

export const TRACKED_TYPES = ["SHORTFALL", "EXCESS", "IN_BANK_NOT_IN_SYSTEM", "IN_SYSTEM_NOT_IN_BANK", "AMOUNT_MISMATCH", "DUPLICATE", "LEDGER_BANK_DIFFERENCE"] as const;

/** Statements must cover the month plus 3 days for every active account with a committed opening balance. */
export async function readiness(db: Db, month: string, scope: ReconScope = {}) {
  const { end } = monthBounds(month);
  const needed = addDays(end, STATEMENT_MARGIN_DAYS);
  const accounts = await db.bankAccount.findMany({
    where: { active: true, ...(scope.bankAccountIds ? { id: { in: scope.bankAccountIds } } : {}) },
    include: { openings: { where: { status: "COMMITTED" } }, statements: { orderBy: { periodTo: "desc" }, take: 1 } },
  });
  const missing: string[] = [];
  for (const a of accounts) {
    if (!a.openings[0]) {
      missing.push(`${a.bankName} ${a.accountNumber}: no committed go-live opening balance. Upload and commit it, or ask Admin to deactivate the account if it isn't used.`);
      continue;
    }
    if (compareDates(day(a.openings[0].asOf), end) > 0) continue; // opens after this month
    const last = a.statements[0];
    if (!last || compareDates(day(last.periodTo), needed) < 0) {
      missing.push(`${a.bankName} ${a.accountNumber}: statements must reach ${needed}${last ? ` (they reach ${day(last.periodTo)})` : " (none imported)"}.`);
    }
  }
  return { needed, missing, accounts };
}

const serialize = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))) as Prisma.InputJsonValue;

/**
 * Runs the month's reconciliation: computes both tracks and both equations,
 * raises or updates exceptions, marks those that resolved as ready to close,
 * and stores the run. Nothing here changes a balance or the ledger.
 */
export async function runReconciliation(db: Db, actor: ReconActor, month: string, today: LocalDate = todayInLagos(), scope: ReconScope = {}) {
  const { end } = monthBounds(month);
  if (compareDates(end, today) >= 0) throw new ReconciliationError(`${month} hasn't ended yet.`);
  if (await db.periodClose.findUnique({ where: { month } })) throw new ReconciliationError(`${month} is closed.`);
  const ready = await readiness(db, month, scope);
  if (ready.missing.length) throw new ReconciliationError(`Import the statements first (to ${ready.needed} for every account):`, ready.missing);

  // Equation (1), per account.
  const accounts = [];
  for (const a of ready.accounts) {
    const position = await accountPosition(db, a.id, end);
    if (!position) continue;
    accounts.push({ id: a.id, label: `${a.bankName} ${a.accountNumber}`, ...position });
  }
  // Equation (2) and Track A.
  const schedules = await trackA(db, month, scope);
  const recorded = schedules.reduce((t, s) => t + s.recorded, 0n);
  const verified = schedules.reduce((t, s) => t + s.verified, 0n);
  const notYetPaid = schedules.reduce((t, s) => t + (s.difference > 0n ? s.difference : 0n), 0n);
  const excess = schedules.reduce((t, s) => t + (s.difference < 0n ? -s.difference : 0n), 0n);

  // Exceptions.
  const plans: ExceptionPlan[] = [];
  for (const s of schedules) {
    if (s.difference === 0n) continue;
    const type = s.difference > 0n ? "SHORTFALL" : "EXCESS";
    const amount = s.difference > 0n ? s.difference : -s.difference;
    plans.push({
      type,
      dedupeKey: `${type}:${s.id}`,
      title: `${type === "SHORTFALL" ? "Shortfall" : "Excess"} of ${naira(amount)} from ${s.source} on schedule ${s.reference} (${s.monthCovered})`,
      amount,
      details: { month, scheduleId: s.id, source: s.source, sourceId: s.sourceId, recorded: s.recorded.toString(), verified: s.verified.toString(), readyToClose: false },
    });
  }
  plans.push(...(await trackBExceptions(db, month, end, scope)));
  for (const a of accounts) {
    if (a.residual === 0n) continue;
    plans.push({
      type: "LEDGER_BANK_DIFFERENCE",
      dedupeKey: `LEDGER_BANK_DIFFERENCE:${a.id}:${month}`,
      title: `${a.label}: bank and ledger differ by ${naira(a.residual < 0n ? -a.residual : a.residual)} at ${end} after every reconciling item`,
      amount: a.residual < 0n ? -a.residual : a.residual,
      details: { month, bankAccountId: a.id, bank: a.bank.toString(), ledger: a.ledger.toString(), readyToClose: false },
    });
  }
  const raised: string[] = [];
  for (const p of plans) {
    const { created } = await raiseException(db, { moduleCode: "CREDIT", type: p.type, dedupeKey: p.dedupeKey, title: p.title, amount: p.amount, details: p.details, raisedById: actor.id, ipAddress: actor.ipAddress });
    if (created) raised.push(p.dedupeKey);
    else await refreshException(db, p.dedupeKey, { amount: p.amount, details: { ...p.details, readyToClose: false } });
  }
  // Exceptions this run no longer finds are ready to close (the GMD still closes them).
  const current = new Set(plans.map((p) => p.dedupeKey));
  const stale = await db.exceptionRecord.findMany({ where: { moduleCode: "CREDIT", type: { in: [...TRACKED_TYPES] }, status: { not: "CLOSED" } } });
  let resolved = 0;
  for (const e of scope.bankAccountIds || scope.sourceIds ? [] : stale) {
    const m = (e.details as { month?: string }).month;
    if (current.has(e.dedupeKey) || (m !== undefined && m > month)) continue;
    await refreshException(db, e.dedupeKey, { amount: 0n, details: { readyToClose: true, resolvedInRun: month } });
    resolved++;
  }

  const results = {
    month,
    end,
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, bank: a.bank, ledger: a.ledger, residual: a.residual, items: a.items })),
    total: {
      bank: accounts.reduce((t, a) => t + a.bank, 0n),
      ledger: accounts.reduce((t, a) => t + a.ledger, 0n),
      residual: accounts.reduce((t, a) => t + a.residual, 0n),
    },
    trackA: { schedules, recorded, verified, notYetPaid, excess, holds: recorded === verified + notYetPaid - excess },
    exceptions: { found: plans.length, raised: raised.length, resolved },
  };
  const run = await db.reconciliationRun.create({ data: { month, runById: actor.id, results: serialize(results) } });
  await writeAudit(db, {
    action: "reconciliation.run",
    entityType: "ReconciliationRun",
    entityId: run.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { month, exceptionsFound: plans.length, raised: raised.length, resolved, residual: results.total.residual.toString() },
  });
  return { run, results };
}

/** Results as stored (amounts are kobo strings). */
export interface StoredResults {
  month: string;
  end: string;
  accounts: Array<{ id: string; label: string; bank: string; ledger: string; residual: string; items: Array<{ kind: ItemKind; amount: string; date: string; label: string; ref: string }> }>;
  total: { bank: string; ledger: string; residual: string };
  trackA: {
    schedules: Array<{ id: string; reference: string; source: string; monthCovered: string; recorded: string; verified: string; difference: string }>;
    recorded: string;
    verified: string;
    notYetPaid: string;
    excess: string;
    holds: boolean;
  };
  exceptions: { found: number; raised: number; resolved: number };
}

export async function latestRun(db: Db, month: string) {
  const run = await db.reconciliationRun.findFirst({ where: { month }, orderBy: { runAt: "desc" } });
  return run ? { ...run, results: run.results as unknown as StoredResults } : null;
}
