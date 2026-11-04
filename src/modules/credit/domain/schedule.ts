import { anniversary, type LocalDate } from "@/lib/dates";
import { applyRate, kobo, spreadEvenly, ZERO, type Bps, type Kobo } from "@/lib/money";

/**
 * Loan terms (PRD F6). For a binding schedule these are the approved amount,
 * approved tenure and the rate the loan was approved at; d0 is the value date
 * of the verified disbursement.
 */
export interface LoanTerms {
  principal: Kobo;
  /** Whole months, 1–12. */
  tenure: number;
  rate: Bps;
  d0: LocalDate;
}

export const MAX_TENURE = 12;

export class LoanTermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanTermsError";
  }
}

export function assertTerms(terms: LoanTerms): void {
  if (terms.principal <= 0n) throw new LoanTermsError("The loan amount must be more than ₦0.");
  if (!Number.isInteger(terms.tenure) || terms.tenure < 1 || terms.tenure > MAX_TENURE) {
    throw new LoanTermsError(`The tenure must be a whole number of months from 1 to ${MAX_TENURE}.`);
  }
  if (terms.rate < 0n) throw new LoanTermsError("The rate cannot be negative.");
}

export interface PlannedInstallment {
  k: number;
  dueDate: LocalDate;
  openingPrincipal: Kobo;
  principal: Kobo;
  interest: Kobo;
  amount: Kobo;
}

export interface PlannedSchedule {
  installments: PlannedInstallment[];
  totalPrincipal: Kobo;
  totalInterest: Kobo;
  total: Kobo;
}

/**
 * The planned schedule if every installment is paid in full on its due date
 * (PRD F6): principal `round_half_up(P / n)` with the last installment taking
 * the remainder, interest `round_half_up(rate × opening principal)`.
 * Used for the indicative calculator and, after approval, the binding schedule.
 */
export function planSchedule(terms: LoanTerms): PlannedSchedule {
  assertTerms(terms);
  const principals = spreadEvenly(terms.principal, terms.tenure);
  let opening = terms.principal;
  let totalInterest = ZERO;
  const installments = principals.map((principal, i) => {
    const interest = applyRate(opening, terms.rate);
    const row: PlannedInstallment = {
      k: i + 1,
      dueDate: anniversary(terms.d0, i + 1),
      openingPrincipal: opening,
      principal,
      interest,
      amount: kobo(principal + interest),
    };
    opening = kobo(opening - principal);
    totalInterest = kobo(totalInterest + interest);
    return row;
  });
  return { installments, totalPrincipal: terms.principal, totalInterest, total: kobo(terms.principal + totalInterest) };
}
