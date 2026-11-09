import type { Loan } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { compareDates, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { kobo, type Kobo } from "@/lib/money";
import { postEvent, reverseEvent } from "@/ledger/post";
import type { Allocation, AllocationKind } from "../domain/allocation";
import { diffAllocations } from "../domain/allocation";
import { computeLoanState, payoffQuote, type LoanPayment, type LoanState } from "../domain/recompute";
import { fromDbDate, loanTerms, moveLoan, toDbDate, type LoanActorUser } from "./common";

type RepaymentLoan = Pick<Loan, "id" | "memberId" | "status" | "loanAccountNo" | "amountApproved" | "tenureApproved" | "rateBps" | "d0">;

/** Payments of one day are applied in the order their schedules posted, then by row (PRD F6). */
export const paymentOrder = (postedAt: Date, rowNo: number) => `${postedAt.toISOString()}|${String(rowNo).padStart(6, "0")}`;

/** Every repayment on the loan: remittance rows allocated to it, less reversed rows. */
export async function loanPayments(db: Db, loanId: string): Promise<LoanPayment[]> {
  const rows = await db.remittanceRow.findMany({
    where: { loanId, toCredit: false, reversedAt: null },
    include: { schedule: { select: { postedAt: true } } },
  });
  return rows.map((r) => ({ id: r.id, date: fromDbDate(r.paymentDate), amount: kobo(r.amount), order: paymentOrder(r.schedule.postedAt, r.rowNo) }));
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
      uniquenessKey: `CREDIT:ALLOC:${a.paymentId}:${a.kind}:${a.installment ?? "-"}:${a.amount}:${ctx.trigger}`,
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
  const terms = loanTerms(loan);
  // A loan that starts after `asOf` (e.g. legacy loans before go-live) is shown as at its start.
  const at = compareDates(asOf, terms.d0) < 0 ? terms.d0 : asOf;
  const rows = await db.remittanceRow.findMany({
    where: { loanId: loan.id, toCredit: false, reversedAt: null },
    include: { schedule: { select: { postedAt: true, scheduleReference: true } } },
    orderBy: [{ paymentDate: "asc" }],
  });
  const payments: LoanPayment[] = rows.map((r) => ({
    id: r.id,
    date: fromDbDate(r.paymentDate),
    amount: kobo(r.amount),
    order: paymentOrder(r.schedule.postedAt, r.rowNo),
  }));
  const state = computeLoanState(terms, payments, at);
  const split = new Map<string, { principal: Kobo; interest: Kobo; credit: Kobo }>();
  for (const a of state.allocations) {
    const s = split.get(a.paymentId) ?? { principal: kobo(0n), interest: kobo(0n), credit: kobo(0n) };
    if (a.kind === "PRINCIPAL") s.principal = kobo(s.principal + a.amount);
    else if (a.kind === "INTEREST") s.interest = kobo(s.interest + a.amount);
    else s.credit = kobo(s.credit + a.amount);
    split.set(a.paymentId, s);
  }
  const repayments = rows.map((r) => ({
    id: r.id,
    date: fromDbDate(r.paymentDate),
    amount: kobo(r.amount),
    reference: r.schedule.scheduleReference,
    ...(split.get(r.id) ?? { principal: kobo(0n), interest: kobo(0n), credit: kobo(0n) }),
  }));
  return { state, repayments, payoff: state.status === "ACTIVE" ? payoffQuote(terms, payments, at) : null };
}
