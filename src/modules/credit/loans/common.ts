import type { Loan, Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { bps, kobo } from "@/lib/money";
import { writeAudit } from "@/shell/audit/audit";
import { getCountSetting } from "@/shell/settings/settings";
import { AWAITING_PAYOUT, canTransition, STATUS_LABEL, type LoanActor, type LoanStatus } from "../domain/loan-status";
import type { LoanTerms } from "../domain/schedule";
import { loanMoved } from "../notices";

/** Messages from this error are written for the user and safe to show. */
export class LoanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanError";
  }
}

export interface LoanActorUser {
  id: string;
  ipAddress: string | null;
}

/**
 * Moves a loan to `to` if the state machine allows `by` to (PRD F7), records
 * the transition with its comment and writes the audit trail. Refuses if the
 * loan changed status meanwhile.
 */
export async function moveLoan(
  db: Db,
  loan: Pick<Loan, "id" | "status">,
  to: LoanStatus,
  by: LoanActor,
  actor: LoanActorUser,
  comment: string | null,
  data: Prisma.LoanUncheckedUpdateManyInput = {},
): Promise<void> {
  if (!canTransition(loan.status, to, by)) {
    throw new LoanError(`A loan that is ${STATUS_LABEL[loan.status].toLowerCase()} can't be moved to ${STATUS_LABEL[to].toLowerCase()} this way.`);
  }
  const { count } = await db.loan.updateMany({ where: { id: loan.id, status: loan.status }, data: { ...data, status: to } });
  if (count !== 1) throw new LoanError("This loan was changed by someone else just now. Reload and try again.");
  const transition = await db.loanTransition.create({ data: { loanId: loan.id, fromStatus: loan.status, toStatus: to, byUserId: actor.id, comment } });
  await writeAudit(db, {
    action: `loan.${to.toLowerCase()}`,
    entityType: "Loan",
    entityId: loan.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { status: loan.status },
    after: { status: to, comment, ...jsonSafe(data) },
  });
  await loanMoved(db, loan.id, loan.status, to, transition.id, actor.id);
}

function jsonSafe(data: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;
}

/** No self-dealing (PRD §3): staff never act on loans of the member their own login belongs to. */
export async function assertNotOwnLoan(db: Db, loan: Pick<Loan, "memberId">, actor: LoanActorUser): Promise<void> {
  const member = await db.member.findUnique({ where: { id: loan.memberId }, select: { userId: true } });
  if (member?.userId === actor.id) throw new LoanError("You can't act on your own loan.");
}

/** Next CSS-YYYY-NNNNN number; the counter runs per year (PRD F7). */
export async function nextLoanNumber(db: Db, on: LocalDate = todayInLagos()): Promise<string> {
  const year = parseInt(on.slice(0, 4), 10);
  const [row] = await db.$queryRaw<Array<{ last: number }>>`
    INSERT INTO "credit"."loan_number_sequence" ("year", "last") VALUES (${year}, 1)
    ON CONFLICT ("year") DO UPDATE SET "last" = "credit"."loan_number_sequence"."last" + 1
    RETURNING "last"`;
  if (!row) throw new Error("Could not issue a loan number");
  return `CSS-${year}-${String(row.last).padStart(5, "0")}`;
}

export interface GuarantorKey {
  /** Member guarantors are identified by MOAUM ID, non-members by phone (PRD F7). */
  moaumIdNumber: string | null;
  phone: string;
}

/**
 * Borrowing and guarantee limits (financial settings, PRD F7): a member may
 * have at most N ACTIVE (paid-out) loans, and a guarantor may stand for at most
 * M active loans. Applications still in review don't count, so the limit is
 * checked at three points:
 *
 *   submit  - refused when the member (or guarantor) already has N active loans;
 *   approve - refused when active loans plus loans approved but not yet paid
 *             already make N (approving would commit another payout);
 *   payout  - refused when N are already active (the Cashier's last check).
 *
 * `loanId` is the loan being checked, which never counts against itself. No override.
 */
export type LimitStage = "submit" | "approve" | "payout";

export async function assertWithinLimits(db: Db, loanId: string | null, memberId: string, guarantor: GuarantorKey, on: LocalDate, stage: LimitStage = "submit"): Promise<void> {
  const [maxLoans, maxGuarantees] = await Promise.all([
    getCountSetting(db, "max_open_loans_per_member", on),
    getCountSetting(db, "max_open_guarantees_per_guarantor", on),
  ]);
  const others = loanId ? { NOT: { id: loanId } } : {};
  const counted: LoanStatus[] = stage === "approve" ? ["ACTIVE", ...AWAITING_PAYOUT] : ["ACTIVE"];
  const [active, waiting] = await Promise.all([
    db.loan.count({ where: { memberId, status: "ACTIVE", ...others } }),
    stage === "approve" ? db.loan.count({ where: { memberId, status: { in: [...AWAITING_PAYOUT] }, ...others } }) : Promise.resolve(0),
  ]);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (active + waiting >= maxLoans) {
    throw new LoanError(
      waiting > 0
        ? `The member already has ${plural(active, "active loan")} and ${plural(waiting, "approved loan")} waiting to be paid; the limit is ${maxLoans} active loans. Approve this one after a loan is fully repaid.`
        : `The member already has ${plural(active, "active loan")}; the limit is ${maxLoans}. A loan must be fully repaid first.`,
    );
  }
  const guaranteed = await db.guarantor.count({
    where: {
      ...(guarantor.moaumIdNumber ? { moaumIdNumber: guarantor.moaumIdNumber } : { phone: guarantor.phone, moaumIdNumber: null }),
      loan: { status: { in: counted }, ...others },
    },
  });
  if (guaranteed >= maxGuarantees) {
    throw new LoanError(
      `The guarantor already guarantees ${plural(guaranteed, stage === "approve" ? "active or approved loan" : "active loan")}; the limit is ${maxGuarantees}. ${stage === "submit" ? "Choose another guarantor." : "Wait until one of those loans is fully repaid."}`,
    );
  }
}

/** The binding terms of an approved, disbursed loan. */
export function loanTerms(
  loan: Pick<Loan, "amountApproved" | "tenureApproved" | "rateBps" | "d0" | "openingArrearsPrincipal" | "openingArrearsInterest">,
): LoanTerms {
  if (loan.amountApproved === null || loan.tenureApproved === null || loan.rateBps === null || loan.d0 === null) {
    throw new Error("The loan has not been approved and disbursed");
  }
  const terms: LoanTerms = {
    principal: kobo(loan.amountApproved),
    tenure: loan.tenureApproved,
    rate: bps(BigInt(loan.rateBps)),
    d0: localDate(loan.d0.toISOString().slice(0, 10)),
  };
  if (loan.openingArrearsPrincipal > 0n || loan.openingArrearsInterest > 0n) {
    terms.openingArrears = { principal: kobo(loan.openingArrearsPrincipal), interest: kobo(loan.openingArrearsInterest) };
  }
  return terms;
}

export const toDbDate = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
export const fromDbDate = (d: Date) => localDate(d.toISOString().slice(0, 10));
