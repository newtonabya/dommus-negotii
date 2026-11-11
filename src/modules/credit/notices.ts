import type { Role } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { queueForMember, queueForMembers, queueForRoles, type Notice } from "@/shell/notifications/messages";
import type { LoanStatus } from "./domain/loan-status";

/**
 * The Credit module's status messages (PRD F15). Each function queues its
 * notices with the caller's database handle, so they join the caller's
 * transaction. Texts are short and plain ASCII ("NGN", not the naira sign):
 * one SMS unit holds 160 such characters but only 70 with other symbols.
 */
const ORG = "MOAUM Credit Super Store";
const APP = "Dommus Negotii";

/** Kobo as "NGN 61,250.00". */
export function ngn(amount: bigint): string {
  const whole = (amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `NGN ${whole}.${String(amount % 100n).padStart(2, "0")}`;
}

const member = (key: string, template: string, text: string): Notice => ({ key, template, subject: ORG, text: `${ORG}: ${text}` });
const staff = (key: string, template: string, subject: string, text: string): Notice => ({ key, template, subject, text: `${text}\n\nSee ${APP}.` });

/** Tells staff that something waits for them; never the person who just acted. */
export async function tellStaff(db: Db, roles: Role[], key: string, template: string, subject: string, text: string, actorId?: string | null): Promise<void> {
  await queueForRoles(db, roles, staff(key, template, subject, text), actorId);
}

export async function tellMember(db: Db, memberId: string, key: string, template: string, text: string): Promise<void> {
  await queueForMember(db, memberId, member(key, template, text));
}

/** A loan changed status (PRD F7): the member hears the outcomes, staff hear what now waits for them. */
export async function loanMoved(db: Db, loanId: string, from: LoanStatus, to: LoanStatus, transitionId: string, actorId: string): Promise<void> {
  const loan = await db.loan.findUnique({
    where: { id: loanId },
    select: { memberId: true, loanAccountNo: true, legacyAccountNo: true, amountRequested: true, amountApproved: true, tenureApproved: true, member: { select: { fullName: true } } },
  });
  // Drafts have no number yet, and legacy loans arrive already running: nothing to tell.
  if (!loan || !loan.loanAccountNo || (from === "DRAFT" && to === "ACTIVE")) return;
  const no = loan.loanAccountNo;
  const key = `loan.${to.toLowerCase()}:${loanId}:${transitionId}`;
  const who = loan.member.fullName;
  const amount = ngn(loan.amountApproved ?? loan.amountRequested);
  const reopened = from === "CLOSED" && to === "ACTIVE";

  const toMember: Partial<Record<LoanStatus, string>> = {
    SUBMITTED: `your loan application ${no} was received and will be reviewed.`,
    APPROVED: `your loan ${no} is approved: ${amount} over ${loan.tenureApproved} months. Payment follows.`,
    DECLINED: `your loan application ${no} was declined. Sign in to see why.`,
    REJECTED: `your loan application ${no} was not approved. Sign in to see why.`,
    CANCELLED: `your loan application ${no} was cancelled.`,
    ACTIVE: reopened ? `your loan ${no} was reopened after a correction. Sign in to see the balance.` : `${amount} was paid out for your loan ${no}. Sign in to see your repayment schedule.`,
    CLOSED: `your loan ${no} is fully repaid and closed. Thank you.`,
  };
  const text = toMember[to];
  if (text) await queueForMember(db, loan.memberId, member(key, `loan.${to.toLowerCase()}`, text));

  const toStaff: Partial<Record<LoanStatus, { roles: Role[]; subject: string; text: string }>> = {
    SUBMITTED: { roles: ["LOAN_OFFICER"], subject: `New loan application ${no}`, text: `${who} applied for ${ngn(loan.amountRequested)} (${no}). It waits for verification.` },
    RECOMMENDED: { roles: ["MANAGEMENT"], subject: `Loan ${no} waits for approval`, text: `${who}'s application ${no} was recommended and waits for Management's decision.` },
    APPROVED: { roles: ["CASHIER"], subject: `Loan ${no} approved: prepare the voucher`, text: `${who}'s loan ${no} (${amount}) is approved. Prepare the disbursement voucher after the transfer.` },
    DISBURSEMENT_PENDING: { roles: ["FINANCE_MANAGER"], subject: `Voucher for loan ${no} waits for verification`, text: `The disbursement voucher for ${who}'s loan ${no} (${amount}) waits for your verification.` },
  };
  const forStaff = reopened ? { roles: ["FINANCE_MANAGER", "LOAN_OFFICER"] as Role[], subject: `Loan ${no} reopened`, text: `${who}'s loan ${no} was closed and is open again after a correction or late posting.` } : toStaff[to];
  if (forStaff) await queueForRoles(db, forStaff.roles, staff(key, `staff.loan.${to.toLowerCase()}`, forStaff.subject, forStaff.text), actorId);
}

/** A schedule was posted: each member hears what was applied for them (PRD F9, F15: a stated control). */
export async function schedulePosted(
  db: Db,
  schedule: { id: string; reference: string; month: string },
  rows: Array<{ id: string; memberId: string; amount: bigint; toCredit: boolean; loanAccountNo: string | null }>,
): Promise<void> {
  await queueForMembers(
    db,
    rows.map((r) => ({
      memberId: r.memberId,
      notice: member(
        `schedule.posted:${r.id}`,
        "schedule.posted",
        r.toCredit || !r.loanAccountNo
          ? `${ngn(r.amount)} received for ${schedule.month} and added to your Overpayment Credit (ref ${schedule.reference}).`
          : `${ngn(r.amount)} received for ${schedule.month} and applied to loan ${r.loanAccountNo} (ref ${schedule.reference}).`,
      ),
    })),
  );
}
