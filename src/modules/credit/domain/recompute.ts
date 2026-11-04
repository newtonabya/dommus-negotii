import { addDays, anniversary, compareDates, cycleOf, type LocalDate } from "@/lib/dates";
import { applyRate, kobo, spreadEvenly, ZERO, type Kobo } from "@/lib/money";
import { arrearsPrincipalCleared, payInstallment, unpaidInterest, unpaidPrincipal, type Allocation, type Dues } from "./allocation";
import { assertTerms, type LoanTerms } from "./schedule";

/**
 * A loan's state is a pure function of its terms, its non-reversed payments and
 * an as-of date (PRD F6 recompute). Payments are taken in payment-date order,
 * then posting order, never upload order, so the result does not depend on the
 * order they arrived in.
 */
export interface LoanPayment {
  id: string;
  /** The payment's own date (`payment_date`), not when it was uploaded or posted. */
  date: LocalDate;
  amount: Kobo;
  /** Posting sequence for payments on the same date, e.g. "<posted_at ISO>|<row no padded>". */
  order: string;
}

export interface InstallmentState {
  k: number;
  /** First and last day of the cycle (A(k−1)+1 … Ak; cycle 1 starts on d0). */
  start: LocalDate;
  dueDate: LocalDate;
  /** Scheduled principal for this installment (after any re-spread); 0 past the tenure. */
  principal: Kobo;
  principalPaid: Kobo;
  /** Bk: the principal this cycle's interest was charged on. */
  interestBase: Kobo;
  interest: Kobo;
  interestPaid: Kobo;
  /** True while the as-of date is inside this cycle: a catch-up payment can still lower the interest. */
  provisional: boolean;
}

export interface LoanState {
  status: "ACTIVE" | "CLOSED";
  closedOn: LocalDate | null;
  /** The cycle the as-of date falls in (or the cycle the loan closed in). */
  currentCycle: number;
  installments: InstallmentState[];
  /** Scheduled principal of installments not reached yet (re-spread after prepayments). */
  futurePrincipal: Array<{ k: number; dueDate: LocalDate; principal: Kobo }>;
  allocations: Allocation[];
  outstandingPrincipal: Kobo;
  /** Unpaid principal and interest of installments whose due date has passed. */
  principalArrears: Kobo;
  interestArrears: Kobo;
  interestCharged: Kobo;
  interestPaid: Kobo;
  overpaymentCredit: Kobo;
}

export class PaymentDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentDateError";
  }
}

const byDateThenOrder = (a: LoanPayment, b: LoanPayment) =>
  compareDates(a.date, b.date) || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const sum = (values: Kobo[]): Kobo => values.reduce((t, v) => kobo(t + v), ZERO);

export function computeLoanState(terms: LoanTerms, payments: readonly LoanPayment[], asOf: LocalDate): LoanState {
  assertTerms(terms);
  for (const p of payments) {
    if (p.amount <= ZERO) throw new PaymentDateError(`Payment ${p.id} must be more than ₦0.`);
    if (compareDates(p.date, terms.d0) < 0) throw new PaymentDateError(`Payment ${p.id} (${p.date}) is dated before the disbursement date ${terms.d0}.`);
  }
  const ordered = payments.filter((p) => compareDates(p.date, asOf) <= 0).sort(byDateThenOrder);
  const n = terms.tenure;

  /** Scheduled principal for installments 1..n, index k−1; re-spread after prepayments. */
  const scheduled = spreadEvenly(terms.principal, n);
  const dues: Dues[] = [];
  const installments: InstallmentState[] = [];
  const allocations: Allocation[] = [];
  let outstanding = terms.principal;
  let closedOn: LocalDate | null = null;
  let overpayment = ZERO;
  let next = 0; // index into `ordered`
  let k = 1;
  let currentCycle = 1;

  for (; closedOn === null; k++) {
    const start = k === 1 ? terms.d0 : addDays(anniversary(terms.d0, k - 1), 1);
    if (compareDates(start, asOf) > 0) break;
    const end = anniversary(terms.d0, k);
    currentCycle = k;

    const inCycle: LoanPayment[] = [];
    while (next < ordered.length && compareDates(ordered[next]!.date, end) <= 0) inCycle.push(ordered[next++]!);

    // Pass 1: principal arrears these payments clear fixes Bk (grace window).
    const arrears = dues.slice();
    const cleared = arrearsPrincipalCleared(arrears, inCycle.map((p) => p.amount));
    const interestBase = kobo(outstanding - cleared);
    const current: Dues = {
      k,
      interest: applyRate(interestBase, terms.rate),
      interestPaid: ZERO,
      principal: k <= n ? scheduled[k - 1]! : ZERO,
      principalPaid: ZERO,
    };
    dues.push(current);

    // Pass 2: allocate each payment: arrears oldest first, this cycle, prepayment, overpayment.
    for (const payment of inCycle) {
      const record = (kind: Allocation["kind"], installment: number | null, amount: Kobo) =>
        allocations.push({ paymentId: payment.id, paymentDate: payment.date, kind, installment, amount });
      let left = payment.amount;
      if (closedOn === null) {
        for (const d of dues) {
          if (left === ZERO) break;
          const before = d.principalPaid;
          left = payInstallment(d, left, record);
          outstanding = kobo(outstanding - (d.principalPaid - before));
        }
        if (left > ZERO && k < n) {
          const future = sum(scheduled.slice(k));
          const prepay = left < future ? left : future;
          if (prepay > ZERO) {
            record("PRINCIPAL", null, prepay);
            left = kobo(left - prepay);
            outstanding = kobo(outstanding - prepay);
            const respread = spreadEvenly(kobo(future - prepay), n - k);
            respread.forEach((p, i) => (scheduled[k + i] = p));
          }
        }
        const interestOwed = sum(dues.map(unpaidInterest));
        if (outstanding === ZERO && interestOwed === ZERO) closedOn = payment.date;
      }
      if (left > ZERO) {
        if (closedOn === null) throw new Error("Internal: money left over on an open loan");
        record("OVERPAYMENT", null, left);
        overpayment = kobo(overpayment + left);
      }
    }

    installments.push({
      k,
      start,
      dueDate: end,
      principal: current.principal,
      principalPaid: current.principalPaid,
      interestBase,
      interest: current.interest,
      interestPaid: current.interestPaid,
      provisional: compareDates(asOf, end) < 0 && closedOn === null,
    });
  }

  // Payments after the loan closed (still within the as-of date) are overpayments.
  for (; next < ordered.length; next++) {
    const p = ordered[next]!;
    allocations.push({ paymentId: p.id, paymentDate: p.date, kind: "OVERPAYMENT", installment: null, amount: p.amount });
    overpayment = kobo(overpayment + p.amount);
  }

  // Each installment's paid figures come from `dues` (arrears can be paid in later cycles).
  installments.forEach((inst, i) => {
    inst.interestPaid = dues[i]!.interestPaid;
    inst.principalPaid = dues[i]!.principalPaid;
  });
  const past = dues.filter((d) => compareDates(anniversary(terms.d0, d.k), asOf) < 0);
  return {
    status: closedOn ? "CLOSED" : "ACTIVE",
    closedOn,
    currentCycle,
    installments,
    futurePrincipal: closedOn
      ? []
      : scheduled.slice(currentCycle).map((principal, i) => ({ k: currentCycle + 1 + i, dueDate: anniversary(terms.d0, currentCycle + 1 + i), principal })),
    allocations,
    outstandingPrincipal: outstanding,
    principalArrears: sum(past.map(unpaidPrincipal)),
    interestArrears: sum(past.map(unpaidInterest)),
    interestCharged: sum(dues.map((d) => d.interest)),
    interestPaid: sum(dues.map((d) => d.interestPaid)),
    overpaymentCredit: overpayment,
  };
}

/** Large enough to pay off any loan in one go when simulating a payoff. */
const PAYOFF_PROBE = kobo(10n ** 15n);

export interface PayoffQuote {
  /** Pays the loan off if paid on or before `validUntil`. */
  amount: Kobo;
  principal: Kobo;
  interest: Kobo;
  /** The end of the current cycle: after this date another cycle's interest is due. */
  validUntil: LocalDate;
}

/**
 * Payoff quote for a payment dated `on` (PRD F6): outstanding principal +
 * interest arrears + the current cycle's interest, worked out by simulating a
 * payment that pays everything, so the quote is exactly what would close the
 * loan, including the lower interest when the payment clears principal arrears
 * inside the grace window. Null when the loan is already closed.
 */
export function payoffQuote(terms: LoanTerms, payments: readonly LoanPayment[], on: LocalDate): PayoffQuote | null {
  const before = computeLoanState(terms, payments, on);
  if (before.status === "CLOSED") return null;
  const probe: LoanPayment = { id: "__payoff_quote__", date: on, amount: PAYOFF_PROBE, order: "￿" };
  const after = computeLoanState(terms, [...payments, probe], on);
  const parts = after.allocations.filter((a) => a.paymentId === probe.id && a.kind !== "OVERPAYMENT");
  const principal = sum(parts.filter((a) => a.kind === "PRINCIPAL").map((a) => a.amount));
  const interest = sum(parts.filter((a) => a.kind === "INTEREST").map((a) => a.amount));
  return { amount: kobo(principal + interest), principal, interest, validUntil: anniversary(terms.d0, cycleOf(terms.d0, on)) };
}
