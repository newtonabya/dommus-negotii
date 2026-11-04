import type { Db } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { kobo, ZERO, type Kobo } from "@/lib/money";
import { getCountSetting } from "@/shell/settings/settings";
import { OPEN_STATUSES, type LoanStatus } from "../domain/loan-status";

/**
 * Outstanding principal per loan from the ledger: principal disbursed
 * (CASH_OUT) less principal recovered (PRINCIPAL_RECOVERY), reversals included.
 */
export async function ledgerPrincipalOutstanding(db: Db, loanIds: string[]): Promise<Map<string, Kobo>> {
  const result = new Map<string, Kobo>();
  if (loanIds.length === 0) return result;
  const rows = await db.ledgerEvent.groupBy({
    by: ["moduleEntityId", "eventType"],
    where: { moduleEntityType: "Loan", moduleEntityId: { in: loanIds }, eventType: { in: ["CASH_OUT", "PRINCIPAL_RECOVERY", "OPENING_BALANCE"] } },
    _sum: { principalAmount: true },
  });
  for (const r of rows) {
    const value = r._sum.principalAmount ?? 0n;
    const signed = r.eventType === "PRINCIPAL_RECOVERY" ? -value : value;
    result.set(r.moduleEntityId, kobo((result.get(r.moduleEntityId) ?? ZERO) + signed));
  }
  return result;
}

/** The member's Overpayment Credit from the ledger (DEPOSIT_CREDITED less DEPOSIT_REFUNDED). */
export async function overpaymentCredit(db: Db, memberId: string): Promise<Kobo> {
  const rows = await db.ledgerEvent.groupBy({
    by: ["eventType"],
    where: { moduleEntityType: "Member", moduleEntityId: memberId, eventType: { in: ["DEPOSIT_CREDITED", "DEPOSIT_REFUNDED"] } },
    _sum: { depositDelta: true },
  });
  let total = ZERO;
  for (const r of rows) total = kobo(total + (r.eventType === "DEPOSIT_REFUNDED" ? -(r._sum.depositDelta ?? 0n) : (r._sum.depositDelta ?? 0n)));
  return total;
}

/**
 * Exposure panel (PRD F7): the applicant's loans, outstanding principal,
 * Overpayment Credit and history, the guarantor's current guarantees, and how
 * close both are to the limits. Arrears appear once repayments are posted (F9).
 */
export async function exposurePanel(db: Db, loanId: string) {
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, include: { guarantor: true } });
  const on = todayInLagos();
  const [loans, maxLoans, maxGuarantees, credit] = await Promise.all([
    db.loan.findMany({ where: { memberId: loan.memberId, status: { not: "DRAFT" } }, orderBy: { createdAt: "desc" } }),
    getCountSetting(db, "max_open_loans_per_member", on),
    getCountSetting(db, "max_open_guarantees_per_guarantor", on),
    overpaymentCredit(db, loan.memberId),
  ]);
  const g = loan.guarantor;
  const guaranteed = g
    ? await db.loan.findMany({
        where: {
          status: { in: [...OPEN_STATUSES] },
          guarantor: g.moaumIdNumber ? { moaumIdNumber: g.moaumIdNumber } : { phone: g.phone, moaumIdNumber: null },
        },
        select: { id: true, loanAccountNo: true, status: true, amountApproved: true, amountRequested: true },
      })
    : [];
  const outstanding = await ledgerPrincipalOutstanding(db, [...loans, ...guaranteed].map((l) => l.id));
  const isOpen = (s: LoanStatus) => OPEN_STATUSES.includes(s);
  const sumOut = (ids: string[]) => ids.reduce((t, id) => kobo(t + (outstanding.get(id) ?? ZERO)), ZERO);
  const openLoans = loans.filter((l) => isOpen(l.status));
  return {
    applicant: {
      loans: loans.map((l) => ({ ...l, outstanding: outstanding.get(l.id) ?? ZERO })),
      openCount: openLoans.length,
      maxOpen: maxLoans,
      outstandingPrincipal: sumOut(openLoans.map((l) => l.id)),
      overpaymentCredit: credit,
      history: {
        closed: loans.filter((l) => l.status === "CLOSED").length,
        declinedOrRejected: loans.filter((l) => l.status === "DECLINED" || l.status === "REJECTED").length,
        cancelled: loans.filter((l) => l.status === "CANCELLED").length,
      },
    },
    guarantor: g
      ? {
          name: g.fullName,
          isMember: Boolean(g.memberId),
          openGuarantees: guaranteed.length,
          maxGuarantees,
          outstandingPrincipal: sumOut(guaranteed.map((l) => l.id)),
          loans: guaranteed.map((l) => ({ ...l, outstanding: outstanding.get(l.id) ?? ZERO })),
        }
      : null,
  };
}

/** Everything the loan pages show. */
export async function loanDetail(db: Db, loanId: string) {
  const loan = await db.loan.findUnique({
    where: { id: loanId },
    include: {
      member: { select: { id: true, fullName: true, phone: true, moaumIdNumber: true, userId: true, idScanEvidenceId: true, status: true } },
      guarantor: true,
      transitions: { orderBy: { at: "asc" } },
      vouchers: { orderBy: { preparedAt: "desc" }, include: { bankAccount: true } },
    },
  });
  if (!loan) return null;
  const userIds = [...new Set([...loan.transitions.map((t) => t.byUserId), ...loan.vouchers.flatMap((v) => [v.preparedById, v.verifiedById ?? ""])])];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? "Unknown") : "");
  return {
    ...loan,
    transitions: loan.transitions.map((t) => ({ ...t, byName: name(t.byUserId) })),
    vouchers: loan.vouchers.map((v) => ({ ...v, preparedByName: name(v.preparedById), verifiedByName: name(v.verifiedById) })),
  };
}

/** The staff loan list, newest activity first. */
export async function listLoans(db: Db, statuses: LoanStatus[] | null, take = 200) {
  return db.loan.findMany({
    where: statuses ? { status: { in: statuses } } : { status: { not: "DRAFT" } },
    orderBy: { updatedAt: "desc" },
    take,
    include: { member: { select: { fullName: true, moaumIdNumber: true } } },
  });
}
