import type { Loan, Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { bps, kobo } from "@/lib/money";
import { writeAudit } from "@/shell/audit/audit";
import { getCountSetting } from "@/shell/settings/settings";
import { canTransition, OPEN_STATUSES, STATUS_LABEL, type LoanActor, type LoanStatus } from "../domain/loan-status";
import type { LoanTerms } from "../domain/schedule";

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
  await db.loanTransition.create({ data: { loanId: loan.id, fromStatus: loan.status, toStatus: to, byUserId: actor.id, comment } });
  await writeAudit(db, {
    action: `loan.${to.toLowerCase()}`,
    entityType: "Loan",
    entityId: loan.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { status: loan.status },
    after: { status: to, comment, ...jsonSafe(data) },
  });
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
 * Borrowing and guarantee limits (financial settings, PRD F7), checked at
 * submission and again at approval. `loanId` is the loan being checked, which
 * never counts against itself. No override.
 */
export async function assertWithinLimits(db: Db, loanId: string | null, memberId: string, guarantor: GuarantorKey, on: LocalDate): Promise<void> {
  const [maxLoans, maxGuarantees] = await Promise.all([
    getCountSetting(db, "max_open_loans_per_member", on),
    getCountSetting(db, "max_open_guarantees_per_guarantor", on),
  ]);
  const others = loanId ? { NOT: { id: loanId } } : {};
  const open = await db.loan.count({ where: { memberId, status: { in: [...OPEN_STATUSES] }, ...others } });
  if (open >= maxLoans) {
    throw new LoanError(`The member already has ${open} open loan${open === 1 ? "" : "s"}; the limit is ${maxLoans}. A loan must close first.`);
  }
  const guaranteed = await db.guarantor.count({
    where: {
      ...(guarantor.moaumIdNumber ? { moaumIdNumber: guarantor.moaumIdNumber } : { phone: guarantor.phone, moaumIdNumber: null }),
      loan: { status: { in: [...OPEN_STATUSES] }, ...others },
    },
  });
  if (guaranteed >= maxGuarantees) {
    throw new LoanError(`The guarantor already guarantees ${guaranteed} open loan${guaranteed === 1 ? "" : "s"}; the limit is ${maxGuarantees}. Choose another guarantor.`);
  }
}

/** The binding terms of an approved, disbursed loan. */
export function loanTerms(loan: Pick<Loan, "amountApproved" | "tenureApproved" | "rateBps" | "d0">): LoanTerms {
  if (loan.amountApproved === null || loan.tenureApproved === null || loan.rateBps === null || loan.d0 === null) {
    throw new Error("The loan has not been approved and disbursed");
  }
  return {
    principal: kobo(loan.amountApproved),
    tenure: loan.tenureApproved,
    rate: bps(BigInt(loan.rateBps)),
    d0: localDate(loan.d0.toISOString().slice(0, 10)),
  };
}

export const toDbDate = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
export const fromDbDate = (d: Date) => localDate(d.toISOString().slice(0, 10));
