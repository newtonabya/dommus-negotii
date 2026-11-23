import type { Loan } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { compareDates, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { kobo, type Kobo } from "@/lib/money";
import { postEvent, reverseEvent } from "@/ledger/post";
import type { Allocation, AllocationKind } from "../domain/allocation";
import { diffAllocations } from "../domain/allocation";
import { actualSchedule, nextPayment, remainingInstalments } from "../domain/projection";
import { computeLoanState, payoffQuote, type LoanPayment, type LoanState } from "../domain/recompute";
import { fromDbDate, loanTerms, moveLoan, toDbDate, type LoanActorUser } from "./common";

type RepaymentLoan = Pick<Loan, "id" | "memberId" | "status" | "loanAccountNo" | "amountApproved" | "tenureApproved" | "rateBps" | "d0" | "openingArrearsPrincipal" | "openingArrearsInterest">;

/** Payments of one day are applied in the order their schedules posted, then by row (PRD F6). */
export const paymentOrder = (postedAt: Date, rowNo: number) => `${postedAt.toISOString()}|${String(rowNo).padStart(6, "0")}`;

/**
 * The loan's remittance rows (not credit rows, not reversed), each with
 * `net`: the amount that counts towards the loan once any verified
 * reclassification to Overpayment Credit is taken off (PRD F12).
 */
export async function loanPaymentRows(db: Db, loanId: string) {
  return (await loanPaymentRowsFor(db, [loanId])).get(loanId) ?? [];
}

export type PaymentRow = Awaited<ReturnType<typeof loanPaymentRows>>[number];

/** Loans per query in `loanPaymentRowsFor`, to keep each `IN (...)` list a sensible size. */
const ROWS_CHUNK = 500;

/**
 * `loanPaymentRows` for many loans in two queries per 500 loans instead of
 * two per loan: reports over every loan were spending minutes on round trips.
 * Every id in `loanIds` is in the result (an empty list when it has no rows).
 */
export async function loanPaymentRowsFor(db: Db, loanIds: readonly string[]) {
  const include = { schedule: { select: { postedAt: true, scheduleReference: true } }, reclassifications: { where: { status: "VERIFIED" as const }, select: { amount: true } } };
  const ids = [...new Set(loanIds)];
  const readChunk = async (chunk: string[]) => {
    const [rows, splits] = await Promise.all([
      db.remittanceRow.findMany({ where: { loanId: { in: chunk }, toCredit: false, reversedAt: null }, include, orderBy: [{ paymentDate: "asc" }] }),
      // Parts of rows shared across several loans (a payroll line naming no loan): each loan's own part only.
      db.remittanceRowSplit.findMany({ where: { loanId: { in: chunk }, row: { reversedAt: null } }, include: { row: { include } } }),
    ]);
    const whole = rows.map((r) => {
      const moved = r.reclassifications.reduce((t, x) => t + x.amount, 0n);
      return { ...r, shared: false, moved: kobo(moved), net: kobo(r.amount - moved) };
    });
    const parts = splits.map((x) => ({ ...x.row, loanId: x.loanId, amount: x.amount, shared: true, moved: kobo(0n), net: kobo(x.amount) }));
    return [...whole, ...parts];
  };
  type Row = Awaited<ReturnType<typeof readChunk>>[number];
  const result = new Map<string, Row[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += ROWS_CHUNK) {
    for (const row of await readChunk(ids.slice(i, i + ROWS_CHUNK))) {
      if (row.loanId !== null) result.get(row.loanId)?.push(row);
    }
  }
  // Whole rows came in payment-date order and parts follow them; the sort is stable, as before.
  for (const rows of result.values()) rows.sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime());
  return result;
}

const asPayment = (r: PaymentRow): LoanPayment => ({
  id: r.id,
  date: fromDbDate(r.paymentDate),
  amount: r.net,
  order: paymentOrder(r.schedule.postedAt, r.rowNo),
});

/** Every repayment on the loan as the engine sees it: reversed rows and reclassified amounts left out. */
export async function loanPayments(db: Db, loanId: string): Promise<LoanPayment[]> {
  return (await loanPaymentRows(db, loanId)).filter((r) => r.net > 0n).map(asPayment);
}

interface PostedAllocation extends Allocation {
  eventId: string;
}

interface AllocationMeta {
  rowId: string;
  kind: AllocationKind;
  installment: number | null;
  paymentDate: string;
}

/** The allocations currently in the ledger for this loan (originals not yet reversed). */
async function postedAllocations(db: Db, loan: RepaymentLoan): Promise<PostedAllocation[]> {
  const events = await db.ledgerEvent.findMany({
    where: {
      source: "REMITTANCE_SCHEDULE",
      reversesEventId: null,
      reversedBy: { is: null },
      OR: [
        { moduleEntityType: "Loan", moduleEntityId: loan.id, eventType: { in: ["PRINCIPAL_RECOVERY", "INTEREST_INCOME"] } },
        { moduleEntityType: "Member", moduleEntityId: loan.memberId, eventType: "DEPOSIT_CREDITED", metadata: { path: ["loanId"], equals: loan.id } },
      ],
    },
  });
  return events.map((e) => {
    const m = e.metadata as unknown as AllocationMeta;
    const amount = e.eventType === "PRINCIPAL_RECOVERY" ? e.principalAmount : e.eventType === "INTEREST_INCOME" ? e.interestAmount : e.depositDelta;
    return { eventId: e.id, paymentId: m.rowId, paymentDate: localDate(m.paymentDate), kind: m.kind, installment: m.installment, amount: kobo(amount) };
  });
}

export interface RecomputePlan {
  state: LoanState;
  toReverse: PostedAllocation[];
  toPost: Allocation[];
}

/** Recomputes the loan from all its payments (PRD F6) and diffs against what the ledger holds. */
export async function planRecompute(db: Db, loan: RepaymentLoan, asOf: LocalDate = todayInLagos(), extra: LoanPayment[] = []): Promise<RecomputePlan> {
  const payments = [...(await loanPayments(db, loan.id)), ...extra];
  const state = computeLoanState(loanTerms(loan), payments, asOf);
  const { toReverse, toPost } = diffAllocations(await postedAllocations(db, loan), state.allocations);
  return { state, toReverse: toReverse as PostedAllocation[], toPost };
}

export interface RecomputeContext {
  actor: LoanActorUser;
  /** What caused the recompute, e.g. "SCHEDULE:<id>"; part of every new event's key. */
  trigger: string;
  /** Evidence for the new events (the schedule file). */
  evidenceId: string;
  reason: string;
  now: Date;
}

const EVENT_OF: Record<AllocationKind, "INTEREST_INCOME" | "PRINCIPAL_RECOVERY" | "DEPOSIT_CREDITED"> = {
  INTEREST: "INTEREST_INCOME",
  PRINCIPAL: "PRINCIPAL_RECOVERY",
  OVERPAYMENT: "DEPOSIT_CREDITED",
};

/**
 * Brings the ledger in line with the recomputed state: reverses allocations
 * that changed, posts the new ones, and closes or reopens the loan.
 */
export async function applyRecompute(db: Db, loan: RepaymentLoan, plan: RecomputePlan, ctx: RecomputeContext): Promise<void> {
  for (const a of plan.toReverse) {
    await reverseEvent(db, a.eventId, {
      uniquenessKey: `CREDIT:REV:${a.eventId}`,
      occurredAt: ctx.now,
      portalUserId: ctx.actor.id,
      evidenceRefs: [ctx.evidenceId],
      reason: ctx.reason,
    });
  }
  for (const a of plan.toPost) {
    const type = EVENT_OF[a.kind];
    const amount: Kobo = a.amount;
    await postEvent(db, {
      occurredAt: toDbDate(a.paymentDate),
      moduleCode: "CREDIT",
      eventType: type,
      source: "REMITTANCE_SCHEDULE",
      evidenceRefs: [ctx.evidenceId],
      portalUserId: ctx.actor.id,
      moduleEntityType: type === "DEPOSIT_CREDITED" ? "Member" : "Loan",
      moduleEntityId: type === "DEPOSIT_CREDITED" ? loan.memberId : loan.id,
      principalAmount: type === "PRINCIPAL_RECOVERY" ? amount : 0n,
      interestAmount: type === "INTEREST_INCOME" ? amount : 0n,
      revenueAmount: type === "INTEREST_INCOME" ? amount : 0n,
      depositDelta: type === "DEPOSIT_CREDITED" ? amount : 0n,
      // The loan is in the key: one row shared across several loans posts on each of them.
      uniquenessKey: `CREDIT:ALLOC:${a.paymentId}:${loan.id}:${a.kind}:${a.installment ?? "-"}:${a.amount}:${ctx.trigger}`,
      metadata: {
        rowId: a.paymentId,
        loanId: loan.id,
        loanAccountNo: loan.loanAccountNo,
        kind: a.kind,
        installment: a.installment,
        paymentDate: a.paymentDate,
      } satisfies AllocationMeta & Record<string, unknown>,
    });
  }
  const { state } = plan;
  if (state.status === "CLOSED" && loan.status === "ACTIVE") {
    await moveLoan(db, loan, "CLOSED", "system", ctx.actor, `Repaid in full on ${state.closedOn}`, {
      closedOn: state.closedOn ? toDbDate(state.closedOn) : null,
    });
  } else if (state.status === "ACTIVE" && loan.status === "CLOSED") {
    await moveLoan(db, loan, "ACTIVE", "system", ctx.actor, "Reopened after a correction", { closedOn: null });
  }
}

/** The loan as of today for the loan pages: engine state, payments with their split, and a payoff quote. */
export async function loanLiveState(db: Db, loan: RepaymentLoan, asOf: LocalDate = todayInLagos()) {
  if (loan.d0 === null || (loan.status !== "ACTIVE" && loan.status !== "CLOSED")) return null;
  return liveStateFrom(loan, await loanPaymentRows(db, loan.id), asOf);
}

/**
 * `loanLiveState` for many loans, with their payment rows read in a few
 * queries (`loanPaymentRowsFor`). Keyed by loan id; a loan not paid out
 * (no d0, or not ACTIVE/CLOSED) maps to null, as `loanLiveState` returns.
 */
export async function loanLiveStates<L extends RepaymentLoan>(db: Db, loans: readonly L[], asOf: LocalDate = todayInLagos()) {
  const running = loans.filter((l) => l.d0 !== null && (l.status === "ACTIVE" || l.status === "CLOSED"));
  const rows = await loanPaymentRowsFor(db, running.map((l) => l.id));
  const states = new Map<string, ReturnType<typeof liveStateFrom> | null>(loans.map((l) => [l.id, null]));
  for (const l of running) states.set(l.id, liveStateFrom(l, rows.get(l.id) ?? [], asOf));
  return states;
}

function liveStateFrom(loan: RepaymentLoan, rows: PaymentRow[], asOf: LocalDate) {
  const terms = loanTerms(loan);
  // A loan that starts after `asOf` (e.g. legacy loans before go-live) is shown as at its start.
  const at = compareDates(asOf, terms.d0) < 0 ? terms.d0 : asOf;
  const payments: LoanPayment[] = rows.filter((r) => r.net > 0n).map(asPayment);
  const state = computeLoanState(terms, payments, at);
  const split = new Map<string, { principal: Kobo; interest: Kobo; credit: Kobo }>();
  for (const a of state.allocations) {
    const s = split.get(a.paymentId) ?? { principal: kobo(0n), interest: kobo(0n), credit: kobo(0n) };
    if (a.kind === "PRINCIPAL") s.principal = kobo(s.principal + a.amount);
    else if (a.kind === "INTEREST") s.interest = kobo(s.interest + a.amount);
    else s.credit = kobo(s.credit + a.amount);
    split.set(a.paymentId, s);
  }
  const repayments = rows.map((r) => {
    const s = split.get(r.id) ?? { principal: kobo(0n), interest: kobo(0n), credit: kobo(0n) };
    // A reclassified part went to Overpayment Credit at the member's request.
    return { id: r.id, date: fromDbDate(r.paymentDate), amount: kobo(r.amount), reference: r.schedule.scheduleReference, ...s, credit: kobo(s.credit + r.moved) };
  });
  // What is left to pay follows the repayments received, not the schedule fixed at disbursement.
  const remaining = remainingInstalments(state, terms.rate, at);
  return { state, repayments, payoff: state.status === "ACTIVE" ? payoffQuote(terms, payments, at) : null, remaining, next: nextPayment(remaining, state), actual: actualSchedule(state, terms.rate, at) };
}
