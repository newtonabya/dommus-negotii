import type { Db } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { parseNaira } from "@/lib/money";
import { getRateSetting } from "@/shell/settings/settings";
import { MAX_TENURE } from "../domain/schedule";
import { assertNotOwnLoan, assertWithinLimits, LoanError, moveLoan, type LoanActorUser } from "./common";

async function loadForReview(db: Db, loanId: string, actor: LoanActorUser) {
  const loan = await db.loan.findUnique({ where: { id: loanId }, include: { guarantor: true } });
  if (!loan) throw new LoanError("Loan not found.");
  await assertNotOwnLoan(db, loan, actor);
  return loan;
}

function requireComment(comment: string, why: string): string {
  const text = comment.trim();
  if (text.length < 5) throw new LoanError(`Add a comment ${why} (at least 5 characters).`);
  return text;
}

/** Loan Officer: KYC and guarantor checked. */
export async function verifyLoan(db: Db, actor: LoanActorUser, loanId: string, comment: string) {
  const loan = await loadForReview(db, loanId, actor);
  const member = await db.member.findUniqueOrThrow({ where: { id: loan.memberId } });
  if (!member.idScanEvidenceId) throw new LoanError("The member's ID card scan is missing: KYC can't be verified.");
  if (!loan.guarantor?.formEvidenceId) throw new LoanError("The signed guarantor form is missing.");
  await moveLoan(db, loan, "VERIFIED", "loan.verify", actor, comment.trim() || null);
}

export async function recommendLoan(db: Db, actor: LoanActorUser, loanId: string, comment: string) {
  const loan = await loadForReview(db, loanId, actor);
  await moveLoan(db, loan, "RECOMMENDED", "loan.recommend", actor, requireComment(comment, "for Management"));
}

export async function declineLoan(db: Db, actor: LoanActorUser, loanId: string, comment: string) {
  const loan = await loadForReview(db, loanId, actor);
  await moveLoan(db, loan, "DECLINED", "loan.decline", actor, requireComment(comment, "explaining why (the member sees it)"));
}

/**
 * Management approves an equal or smaller amount, with the tenure possibly
 * adjusted (PRD F7). The rate in force today is fixed on the loan. Limits are
 * checked again.
 */
export async function approveLoan(db: Db, actor: LoanActorUser, loanId: string, input: { amount: string; tenure: string; comment: string }) {
  const loan = await loadForReview(db, loanId, actor);
  let amount: bigint;
  try {
    amount = parseNaira(input.amount.trim());
  } catch {
    throw new LoanError("Enter the approved amount in naira, e.g. 150,000.");
  }
  if (amount <= 0n) throw new LoanError("The approved amount must be more than ₦0.");
  if (amount > loan.amountRequested) throw new LoanError("The approved amount can't be more than the amount requested.");
  const tenure = parseInt(input.tenure, 10);
  if (!/^\d{1,2}$/.test(input.tenure.trim()) || tenure < 1 || tenure > MAX_TENURE) throw new LoanError(`Tenure is 1 to ${MAX_TENURE} months.`);
  if (!loan.guarantor) throw new LoanError("The loan has no guarantor.");
  const today = todayInLagos();
  await assertWithinLimits(db, loan.id, loan.memberId, loan.guarantor, today);
  const rate = await getRateSetting(db, "interest_rate_bps", today);
  await moveLoan(db, loan, "APPROVED", "loan.approve", actor, input.comment.trim() || null, {
    amountApproved: amount,
    tenureApproved: tenure,
    rateBps: parseInt(rate.toString(), 10),
  });
}

export async function rejectLoan(db: Db, actor: LoanActorUser, loanId: string, comment: string) {
  const loan = await loadForReview(db, loanId, actor);
  await moveLoan(db, loan, "REJECTED", "loan.reject", actor, requireComment(comment, "explaining why (the member sees it)"));
}

/** Management cancels an approved loan before any voucher is prepared. */
export async function cancelApprovedLoan(db: Db, actor: LoanActorUser, loanId: string, comment: string) {
  const loan = await loadForReview(db, loanId, actor);
  await moveLoan(db, loan, "CANCELLED", "loan.cancelApproved", actor, requireComment(comment, "explaining why"));
}
