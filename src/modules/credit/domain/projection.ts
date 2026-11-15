import { compareDates, type LocalDate } from "@/lib/dates";
import { applyRate, kobo, type Bps, type Kobo } from "@/lib/money";
import type { LoanState } from "./recompute";

/**
 * What is still to pay on a loan, as it stands today. The schedule fixed at
 * disbursement is the contract; this is what follows from the repayments
 * actually received. Paying more lowers the principal still owed, so the later
 * instalments (and their interest) shrink; paying less leaves the unpaid part
 * due now, on top of the current instalment.
 *
 * Cycles already reached keep whatever is unpaid of them. Cycles still to come
 * take their (re-spread) scheduled principal plus interest on the principal
 * then outstanding, assuming each instalment before them is paid as listed.
 */
export interface RemainingInstalment {
  k: number;
  dueDate: LocalDate;
  principal: Kobo;
  interest: Kobo;
  amount: Kobo;
  /** Its due date has passed and it is still unpaid. */
  overdue: boolean;
}

export function remainingInstalments(state: LoanState, rate: Bps, asOf: LocalDate): RemainingInstalment[] {
  if (state.status !== "ACTIVE") return [];
  const out: RemainingInstalment[] = [];
  for (const i of state.installments) {
    const principal = kobo(i.principal - i.principalPaid);
    const interest = kobo(i.interest - i.interestPaid);
    if (principal + interest <= 0n) continue;
    out.push({ k: i.k, dueDate: i.dueDate, principal, interest, amount: kobo(principal + interest), overdue: compareDates(i.dueDate, asOf) < 0 });
  }
  let balance = state.futurePrincipal.reduce((t, f) => t + f.principal, 0n);
  for (const f of state.futurePrincipal) {
    const interest = applyRate(kobo(balance), rate);
    out.push({ k: f.k, dueDate: f.dueDate, principal: f.principal, interest, amount: kobo(f.principal + interest), overdue: false });
    balance -= f.principal;
  }
  return out;
}

/**
 * The next payment: everything already due (overdue amounts and the current
 * instalment together), or else the next instalment to come. Null once nothing
 * is left.
 */
export interface NextPayment {
  k: number;
  dueDate: LocalDate;
  amount: Kobo;
  /** Of which is overdue from earlier instalments. */
  overdue: Kobo;
}

export function nextPayment(rows: readonly RemainingInstalment[], state: LoanState): NextPayment | null {
  const reached = new Set(state.installments.map((i) => i.k));
  const due = rows.filter((r) => reached.has(r.k));
  if (due.length === 0) {
    const first = rows[0];
    return first ? { k: first.k, dueDate: first.dueDate, amount: first.amount, overdue: kobo(0n) } : null;
  }
  const last = due.at(-1) as RemainingInstalment;
  return {
    k: last.k,
    dueDate: last.dueDate,
    amount: kobo(due.reduce((t, r) => t + r.amount, 0n)),
    overdue: kobo(due.filter((r) => r.overdue).reduce((t, r) => t + r.amount, 0n)),
  };
}
