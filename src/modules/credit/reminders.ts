import type { PrismaClient } from "@/generated/prisma/client";
import { addDays, compareDates, todayInLagos, type LocalDate } from "@/lib/dates";
import { queueForMembers, type Notice } from "@/shell/notifications/messages";
import { getCountSetting } from "@/shell/settings/settings";
import { loanLiveState } from "./loans/repayments";
import { ngn } from "./notices";

/**
 * Member reminders (PRD F15), queued by the scheduled job:
 * - members who pay directly (no remittance source) are reminded a set number
 *   of days before each instalment is due;
 * - every member with arrears is reminded a set number of days after the due
 *   date, once per cycle while arrears remain.
 * Each reminder is sent once: its key names the loan and the due date.
 */
export async function queueReminders(
  db: PrismaClient,
  today: LocalDate = todayInLagos(),
  /** Tests limit a run to their own loans. */
  scope: { loanIds?: string[] } = {},
): Promise<{ loans: number; dueSoon: number; arrears: number }> {
  const before = await getCountSetting(db, "reminder_days_before_due", today);
  const after = await getCountSetting(db, "arrears_reminder_days_after_due", today);
  const loans = await db.loan.findMany({
    where: { status: "ACTIVE", d0: { not: null }, member: { status: "ACTIVE" }, ...(scope.loanIds ? { id: { in: scope.loanIds } } : {}) },
    include: { member: { select: { id: true, remittanceSourceId: true } } },
  });
  const notices: Array<{ memberId: string; notice: Notice }> = [];
  let dueSoon = 0;
  let arrears = 0;
  for (const loan of loans) {
    const live = await loanLiveState(db, loan, today);
    if (!live || live.state.status !== "ACTIVE") continue;
    const no = loan.loanAccountNo ?? loan.legacyAccountNo ?? "your loan";
    const unpaid = (i: (typeof live.state.installments)[number]) => i.principal - i.principalPaid + (i.interest - i.interestPaid);

    if (loan.member.remittanceSourceId === null) {
      const next = live.state.installments.find((i) => compareDates(i.dueDate, today) >= 0 && unpaid(i) > 0n);
      if (next && compareDates(addDays(next.dueDate, -before), today) <= 0) {
        dueSoon++;
        notices.push({
          memberId: loan.member.id,
          notice: {
            key: `reminder.due:${loan.id}:${next.dueDate}`,
            template: "reminder.due",
            subject: "MOAUM Credit Super Store",
            text: `MOAUM Credit Super Store: ${ngn(unpaid(next))} is due on ${next.dueDate} for loan ${no}. Please pay into the MOAUM account and keep your teller.`,
          },
        });
      }
    }

    const overdue = live.state.principalArrears + live.state.interestArrears;
    if (overdue > 0n) {
      const passed = live.state.installments.filter((i) => compareDates(i.dueDate, today) < 0);
      const lastDue = passed.at(-1)?.dueDate;
      if (lastDue && compareDates(addDays(lastDue, after), today) <= 0) {
        arrears++;
        notices.push({
          memberId: loan.member.id,
          notice: {
            key: `reminder.arrears:${loan.id}:${lastDue}`,
            template: "reminder.arrears",
            subject: "MOAUM Credit Super Store",
            text: `MOAUM Credit Super Store: ${ngn(overdue)} is overdue on loan ${no} (due ${lastDue}). Please pay, or contact the office if this is wrong.`,
          },
        });
      }
    }
  }
  await queueForMembers(db, notices);
  return { loans: loans.length, dueSoon, arrears };
}
