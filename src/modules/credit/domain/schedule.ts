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
  /**
   * Legacy loans only: what the member was already behind by on d0 (the
   * go-live date). The principal part is inside `principal`; the interest part
   * is owed on top. Both form instalment 0, due on d0, which repayments clear first.
   */
  openingArrears?: { principal: Kobo; interest: Kobo };
}

/** The opening arrears, or zero. */
export const openingArrearsOf = (terms: LoanTerms): { principal: Kobo; interest: Kobo } => terms.openingArrears ?? { principal: ZERO, interest: ZERO };

/** How an instalment is numbered on screen and in PDFs: instalment 0 is the arrears brought in at go-live. */
export const instalmentLabel = (k: number): string => (k === 0 ? "Arrears at go-live" : String(k));

/** True when the loan starts with arrears (an instalment 0). */
export const hasOpeningArrears = (terms: LoanTerms): boolean => {
  const a = openingArrearsOf(terms);
  return a.principal > ZERO || a.interest > ZERO;
};

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
  const a = openingArrearsOf(terms);
  if (a.principal < 0n || a.interest < 0n) throw new LoanTermsError("Arrears can't be negative.");
  if (a.principal > terms.principal) throw new LoanTermsError("The principal in arrears can't be more than the principal still owed.");
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
 *
 * Opening arrears (legacy loans) come first as instalment 0, due on d0; the
 * plan assumes they are paid then, so instalments 1…n spread the rest of the
 * principal and charge interest on it.
 */
export function planSchedule(terms: LoanTerms): PlannedSchedule {
  assertTerms(terms);
  const arrears = openingArrearsOf(terms);
  const head: PlannedInstallment[] = hasOpeningArrears(terms)
    ? [{ k: 0, dueDate: terms.d0, openingPrincipal: terms.principal, principal: arrears.principal, interest: arrears.interest, amount: kobo(arrears.principal + arrears.interest) }]
    : [];
  const rest = kobo(terms.principal - arrears.principal);
  const principals = spreadEvenly(rest, terms.tenure);
  let opening = rest;
  let totalInterest = arrears.interest;
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
  return { installments: [...head, ...installments], totalPrincipal: terms.principal, totalInterest, total: kobo(terms.principal + totalInterest) };
}
