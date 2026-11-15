import type { Db } from "@/lib/db";
import { loanLiveState } from "./repayments";

/** Legacy loans were running before the portal; they are brought in at go-live with this purpose. */
export const LEGACY_PURPOSE = "Loan brought in from MOAUM's records at go-live";

export interface LoanHistoryRow {
  id: string;
  no: string;
  legacy: boolean;
  amount: bigint;
  months: number;
  /** YYYY-MM-DD the money was paid out (go-live for a legacy loan). */
  taken: string;
  /** YYYY-MM-DD the loan was cleared; empty while it runs. */
  completed: string;
  repaid: bigint;
  /** Principal still owed; 0 once completed. */
  left: bigint;
}

export interface LoanHistory {
  rows: LoanHistoryRow[];
  completed: number;
  ongoing: number;
  borrowed: bigint;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

/**
 * Every loan a member has taken from MOAUM (paid out, or brought in at
 * go-live), in the order taken: completed ones with the date they were
 * cleared, and any still running. Applications that never paid out are left out.
 */
export async function loanHistory(db: Db, memberId: string): Promise<LoanHistory> {
  const loans = await db.loan.findMany({
    where: { memberId, status: { in: ["ACTIVE", "CLOSED"] }, d0: { not: null } },
    orderBy: [{ d0: "asc" }, { createdAt: "asc" }],
  });
  const live = await Promise.all(loans.map((l) => loanLiveState(db, l)));
  const rows = loans.map((l, i) => {
    const state = live[i];
    return {
      id: l.id,
      no: l.loanAccountNo ?? l.legacyAccountNo ?? "—",
      legacy: l.purpose === LEGACY_PURPOSE,
      amount: l.amountApproved ?? l.amountRequested,
      months: l.tenureApproved ?? l.tenureRequested,
      taken: day(l.d0),
      completed: l.status === "CLOSED" ? day(l.closedOn) || state?.state.closedOn || "" : "",
      repaid: (state?.repayments ?? []).reduce((t, r) => t + r.amount, 0n),
      left: state?.state.status === "ACTIVE" ? state.state.outstandingPrincipal : 0n,
    };
  });
  const completed = rows.filter((r) => r.completed).length;
  return { rows, completed, ongoing: rows.length - completed, borrowed: rows.reduce((t, r) => t + r.amount, 0n) };
}

/** Loans taken and still running per member, for lists (no replay of payments). */
export async function loanCounts(db: Db): Promise<Map<string, { taken: number; ongoing: number }>> {
  const groups = await db.loan.groupBy({ by: ["memberId", "status"], where: { status: { in: ["ACTIVE", "CLOSED"] }, d0: { not: null } }, _count: { _all: true } });
  const out = new Map<string, { taken: number; ongoing: number }>();
  for (const g of groups) {
    const c = out.get(g.memberId) ?? { taken: 0, ongoing: 0 };
    c.taken += g._count._all;
    if (g.status === "ACTIVE") c.ongoing += g._count._all;
    out.set(g.memberId, c);
  }
  return out;
}
