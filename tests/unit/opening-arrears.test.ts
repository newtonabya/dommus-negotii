/**
 * Legacy loans that start behind: arrears at go-live are instalment 0, due on
 * d0, cleared first, and counted like any other overdue amount.
 *
 * Example: ₦100,000 still owed at go-live 2026-10-01, 4 months left, 7.5% a
 * month, of which ₦20,000 principal is already overdue, plus ₦3,000 interest
 * overdue on top.
 */
import { localDate } from "@/lib/dates";
import { bps, kobo, type Kobo } from "@/lib/money";
import { actualSchedule, nextPayment, remainingInstalments } from "@/modules/credit/domain/projection";
import { computeLoanState, payoffQuote, type LoanPayment } from "@/modules/credit/domain/recompute";
import { assertTerms, instalmentLabel, LoanTermsError, planSchedule, type LoanTerms } from "@/modules/credit/domain/schedule";

const N = (naira: number): Kobo => kobo(BigInt(Math.round(naira * 100)));
const terms: LoanTerms = {
  principal: N(100_000),
  tenure: 4,
  rate: bps(750n),
  d0: localDate("2026-10-01"),
  openingArrears: { principal: N(20_000), interest: N(3_000) },
};
const pay = (id: string, date: string, naira: number): LoanPayment => ({ id, date: localDate(date), amount: N(naira), order: id });

describe("arrears at go-live", () => {
  it("plans them as instalment 0, due on go-live day, then spreads the rest", () => {
    const plan = planSchedule(terms);
    expect(plan.installments.map((i) => [i.k, i.dueDate, i.principal, i.interest, i.amount])).toEqual([
      [0, "2026-10-01", N(20_000), N(3_000), N(23_000)],
      [1, "2026-11-01", N(20_000), N(6_000), N(26_000)],
      [2, "2026-12-01", N(20_000), N(4_500), N(24_500)],
      [3, "2027-01-01", N(20_000), N(3_000), N(23_000)],
      [4, "2027-02-01", N(20_000), N(1_500), N(21_500)],
    ]);
    expect(plan.totalPrincipal).toBe(N(100_000));
    expect(plan.totalInterest).toBe(N(18_000));
    expect(instalmentLabel(0)).toBe("Arrears at go-live");
    expect(instalmentLabel(3)).toBe("3");
  });

  it("shows them as overdue from the day after go-live, with interest on the unpaid principal", () => {
    const state = computeLoanState(terms, [], localDate("2026-10-15"));
    expect(state.principalArrears).toBe(N(20_000));
    expect(state.interestArrears).toBe(N(3_000));
    expect(state.outstandingPrincipal).toBe(N(100_000));
    // Nothing paid yet: cycle 1's interest is on everything still owed, overdue principal included.
    expect(state.installments.find((i) => i.k === 1)?.interest).toBe(N(7_500));
    const rows = remainingInstalments(state, terms.rate, localDate("2026-10-15"));
    expect(rows[0]).toMatchObject({ k: 0, amount: N(23_000), overdue: true });
    expect(nextPayment(rows, state)).toMatchObject({ k: 1, amount: N(50_500), overdue: N(23_000) });
    // On go-live day itself nothing is overdue yet.
    expect(computeLoanState(terms, [], localDate("2026-10-01")).principalArrears).toBe(N(0));
  });

  it("follows the plan exactly when the arrears are paid on go-live day", () => {
    const state = computeLoanState(terms, [pay("a", "2026-10-01", 23_000)], localDate("2026-10-15"));
    expect(state.principalArrears).toBe(N(0));
    expect(state.interestArrears).toBe(N(0));
    expect(state.outstandingPrincipal).toBe(N(80_000));
    expect(state.installments.find((i) => i.k === 1)?.interest).toBe(N(6_000));
    expect(state.allocations.map((a) => [a.kind, a.installment, a.amount])).toEqual([
      ["INTEREST", 0, N(3_000)],
      ["PRINCIPAL", 0, N(20_000)],
    ]);
  });

  it("clears them first, interest before principal, before the current instalment", () => {
    const state = computeLoanState(terms, [pay("a", "2026-10-20", 30_000)], localDate("2026-10-25"));
    expect(state.allocations.map((a) => [a.kind, a.installment, a.amount])).toEqual([
      ["INTEREST", 0, N(3_000)],
      ["PRINCIPAL", 0, N(20_000)],
      // Paid inside cycle 1, so cycle 1's interest is on ₦80,000 (the grace window).
      ["INTEREST", 1, N(6_000)],
      ["PRINCIPAL", 1, N(1_000)],
    ]);
    expect(state.interestArrears).toBe(N(0));
    const actual = actualSchedule(state, terms.rate, localDate("2026-10-25"));
    expect(actual.rows[0]).toMatchObject({ k: 0, amount: N(23_000), paid: N(23_000), status: "PAID" });
    expect(actual.rows[1]).toMatchObject({ k: 1, amount: N(26_000), paid: N(7_000), status: "PART_PAID" });
  });

  it("partly paid arrears stay overdue", () => {
    const state = computeLoanState(terms, [pay("a", "2026-10-10", 5_000)], localDate("2026-10-25"));
    expect(state.interestArrears).toBe(N(0));
    expect(state.principalArrears).toBe(N(18_000));
  });

  it("is paid off by the quote, arrears included", () => {
    const quote = payoffQuote(terms, [], localDate("2026-10-20"));
    // ₦100,000 principal, ₦3,000 overdue interest, and cycle 1's interest on ₦80,000
    // (paying the overdue principal inside the cycle lowers its base): ₦6,000.
    expect(quote?.principal).toBe(N(100_000));
    expect(quote?.interest).toBe(N(9_000));
    const closed = computeLoanState(terms, [pay("q", "2026-10-20", Number(quote!.amount) / 100)], localDate("2026-10-20"));
    expect(closed.status).toBe("CLOSED");
  });

  it("refuses arrears that don't fit the loan", () => {
    expect(() => assertTerms({ ...terms, openingArrears: { principal: N(100_001), interest: N(0) } })).toThrow(LoanTermsError);
    expect(() => assertTerms({ ...terms, openingArrears: { principal: N(0), interest: kobo(-1n) } })).toThrow(LoanTermsError);
  });

  it("leaves a loan without arrears exactly as before", () => {
    const plain = { ...terms, openingArrears: undefined };
    expect(planSchedule(plain).installments[0]?.k).toBe(1);
    expect(computeLoanState(plain, [], localDate("2026-10-15")).installments.map((i) => i.k)).toEqual([1]);
  });
});
