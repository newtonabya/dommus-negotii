import type { LocalDate } from "@/lib/dates";
import { kobo, ZERO, type Kobo } from "@/lib/money";

/**
 * Where part of a payment went (PRD F6). These map one-to-one to ledger
 * events: INTEREST → INTEREST_INCOME, PRINCIPAL → PRINCIPAL_RECOVERY,
 * OVERPAYMENT → DEPOSIT_CREDITED.
 */
export type AllocationKind = "INTEREST" | "PRINCIPAL" | "OVERPAYMENT";

export interface Allocation {
  paymentId: string;
  paymentDate: LocalDate;
  kind: AllocationKind;
  /** The installment (cycle) it paid; null for a prepayment of future principal or an overpayment. */
  installment: number | null;
  amount: Kobo;
}

/** One installment's dues and what has been paid against them so far. */
export interface Dues {
  k: number;
  interest: Kobo;
  interestPaid: Kobo;
  principal: Kobo;
  principalPaid: Kobo;
}

export const unpaidInterest = (d: Dues): Kobo => kobo(d.interest - d.interestPaid);
export const unpaidPrincipal = (d: Dues): Kobo => kobo(d.principal - d.principalPaid);

const smaller = (a: Kobo, b: Kobo): Kobo => (a < b ? a : b);

/**
 * Pays as much of `amount` as it can towards `dues`, interest before
 * principal, recording each part. Returns what is left of the amount.
 * With `principalOnly`, interest is skipped (never used for arrears; kept for
 * clarity of the two allocation passes).
 */
export function payInstallment(
  dues: Dues,
  amount: Kobo,
  record: (kind: AllocationKind, installment: number, paid: Kobo) => void,
): Kobo {
  let left = amount;
  const interest = smaller(left, unpaidInterest(dues));
  if (interest > ZERO) {
    dues.interestPaid = kobo(dues.interestPaid + interest);
    left = kobo(left - interest);
    record("INTEREST", dues.k, interest);
  }
  const principal = smaller(left, unpaidPrincipal(dues));
  if (principal > ZERO) {
    dues.principalPaid = kobo(dues.principalPaid + principal);
    left = kobo(left - principal);
    record("PRINCIPAL", dues.k, principal);
  }
  return left;
}

/**
 * How much principal a run of payments would clear from the arrears of
 * earlier installments (oldest first, interest before principal), without
 * changing anything. This fixes a cycle's interest base before the cycle's
 * payments are allocated (PRD F6 grace window).
 */
export function arrearsPrincipalCleared(arrears: readonly Dues[], amounts: readonly Kobo[]): Kobo {
  const owed = arrears.map((d) => ({ interest: unpaidInterest(d), principal: unpaidPrincipal(d) }));
  let cleared = ZERO;
  for (const amount of amounts) {
    let left = amount;
    for (const o of owed) {
      if (left === ZERO) break;
      const i = smaller(left, o.interest);
      o.interest = kobo(o.interest - i);
      left = kobo(left - i);
      const p = smaller(left, o.principal);
      o.principal = kobo(o.principal - p);
      left = kobo(left - p);
      cleared = kobo(cleared + p);
    }
  }
  return cleared;
}

/**
 * The difference between the allocations already posted and those of the
 * recomputed state (PRD F6 recompute): what to reverse and what to post.
 * Allocations are compared as a multiset, so unchanged ones produce nothing.
 */
export function diffAllocations(posted: readonly Allocation[], recomputed: readonly Allocation[]) {
  const key = (a: Allocation) => `${a.paymentId}|${a.kind}|${a.installment ?? "-"}|${a.amount}`;
  const remaining = new Map<string, number>();
  for (const a of recomputed) remaining.set(key(a), (remaining.get(key(a)) ?? 0) + 1);
  const toReverse: Allocation[] = [];
  for (const a of posted) {
    const n = remaining.get(key(a)) ?? 0;
    if (n > 0) remaining.set(key(a), n - 1);
    else toReverse.push(a);
  }
  const kept = new Map<string, number>();
  for (const a of posted) kept.set(key(a), (kept.get(key(a)) ?? 0) + 1);
  const toPost: Allocation[] = [];
  for (const a of recomputed) {
    const n = kept.get(key(a)) ?? 0;
    if (n > 0) kept.set(key(a), n - 1);
    else toPost.push(a);
  }
  return { toReverse, toPost };
}
