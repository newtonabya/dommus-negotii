/**
 * What is left to pay follows the repayments received, not the schedule fixed
 * at payout: an overpayment lowers the later instalments, a shortfall stays due.
 */
import { localDate } from "@/lib/dates";
import { bps, formatNaira, parseNaira } from "@/lib/money";
import { actualSchedule, nextPayment, remainingInstalments } from "@/modules/credit/domain/projection";
import { computeLoanState, type LoanPayment } from "@/modules/credit/domain/recompute";
import type { LoanTerms } from "@/modules/credit/domain/schedule";

const d = (s: string) => localDate(s);
const pay = (date: string, amount: string, id: string): LoanPayment => ({ id, date: d(date), amount: parseNaira(amount), order: id });
const terms: LoanTerms = { principal: parseNaira("100,000"), tenure: 2, rate: bps(750n), d0: d("2026-11-14") };
const view = (payments: LoanPayment[], asOf: string) => {
  const state = computeLoanState(terms, payments, d(asOf));
  const rows = remainingInstalments(state, terms.rate, d(asOf));
  const next = nextPayment(rows, state);
  return {
    rows: rows.map((r) => `${r.k} ${r.dueDate} ${formatNaira(r.amount)}${r.overdue ? " overdue" : ""}`),
    next: next && `${next.dueDate} ${formatNaira(next.amount)} (overdue ${formatNaira(next.overdue)})`,
  };
};

describe("what is left to pay", () => {
  it("as planned before anything is paid", () => {
    expect(view([], "2026-11-20")).toEqual({
      rows: ["1 2026-12-14 ₦57,500.00", "2 2027-01-14 ₦53,750.00"],
      next: "2026-12-14 ₦57,500.00 (overdue ₦0.00)",
    });
  });

  it("an overpayment lowers the next instalment to what is really left", () => {
    // ₦97,500 against a ₦57,500 instalment: ₦7,500 interest and ₦90,000 principal, leaving ₦10,000.
    const v = view([pay("2026-12-10", "97,500", "a")], "2026-12-20");
    expect(v.rows).toEqual(["2 2027-01-14 ₦10,750.00"]);
    expect(v.next).toBe("2027-01-14 ₦10,750.00 (overdue ₦0.00)");
  });

  it("a shortfall stays due, on top of the next instalment", () => {
    const v = view([pay("2026-12-10", "30,000", "a")], "2027-01-05");
    expect(v.rows[0]).toBe("1 2026-12-14 ₦27,500.00 overdue");
    expect(v.next).toMatch(/^2027-01-14 .* \(overdue ₦27,500\.00\)$/);
  });

  it("nothing is left once the loan is cleared", () => {
    const v = view([pay("2026-12-10", "57,500", "a"), pay("2027-01-10", "53,750", "b")], "2027-01-20");
    expect(v).toEqual({ rows: [], next: null });
  });

  it("the actual schedule shows each instalment as it really fell, what was paid and what was paid ahead", () => {
    const at = (payments: LoanPayment[], asOf: string) => {
      const a = actualSchedule(computeLoanState(terms, payments, d(asOf)), terms.rate, d(asOf));
      return {
        rows: a.rows.map((r) => `${r.k} ${r.dueDate} ${formatNaira(r.amount)} paid ${formatNaira(r.paid)} left ${formatNaira(r.left)} ${r.status}`),
        ahead: a.paidAhead.map((p) => `${p.date} ${formatNaira(p.amount)}`),
      };
    };
    // Newton's case: ₦97,500 paid against the first ₦57,500.
    expect(at([pay("2026-11-14", "97,500", "a")], "2026-11-20")).toEqual({
      rows: ["1 2026-12-14 ₦57,500.00 paid ₦57,500.00 left ₦0.00 PAID", "2 2027-01-14 ₦10,750.00 paid ₦0.00 left ₦10,750.00 TO_COME"],
      ahead: ["2026-11-14 ₦40,000.00"],
    });
    // A shortfall: part of the first instalment is left, and it is overdue once its date passes.
    expect(at([pay("2026-12-10", "30,000", "a")], "2027-01-05").rows[0]).toBe("1 2026-12-14 ₦57,500.00 paid ₦30,000.00 left ₦27,500.00 OVERDUE");
    expect(at([pay("2026-12-10", "30,000", "a")], "2026-12-12").rows[0]).toBe("1 2026-12-14 ₦57,500.00 paid ₦30,000.00 left ₦27,500.00 PART_PAID");
  });
});
