/**
 * Loan engine (PRD F6): the worked examples A–I and the DoD checks, exact to the kobo.
 * ₦100,000 over 10 months at 7.5% per month, d0 = 1 March 2026 unless stated.
 */
import { anniversary, localDate, type LocalDate } from "@/lib/dates";
import { bps, formatNaira, parseNaira, type Kobo } from "@/lib/money";
import { diffAllocations } from "@/modules/credit/domain/allocation";
import { computeLoanState, payoffQuote, type LoanPayment } from "@/modules/credit/domain/recompute";
import { planSchedule, type LoanTerms } from "@/modules/credit/domain/schedule";

const d = (s: string) => localDate(s);
const ngn = (s: string) => parseNaira(s);
const show = (k: Kobo) => formatNaira(k);
const terms: LoanTerms = { principal: ngn("100,000"), tenure: 10, rate: bps(750n), d0: d("2026-03-01") };
let seq = 0;
const pay = (date: string, amount: string, id = `p${++seq}`, order = `o${String(seq).padStart(4, "0")}`): LoanPayment => ({
  id,
  date: d(date),
  amount: ngn(amount),
  order,
});
const state = (payments: LoanPayment[], asOf: string, t: LoanTerms = terms) => computeLoanState(t, payments, d(asOf));
const interestOf = (payments: LoanPayment[], asOf: string, k: number) => show(state(payments, asOf).installments[k - 1]!.interest);

describe("planned schedule", () => {
  it("[AT-a] ₦100,000 over 10 months", () => {
    const plan = planSchedule(terms);
    expect(plan.installments.map((i) => show(i.amount))).toEqual([
      "₦17,500.00", "₦16,750.00", "₦16,000.00", "₦15,250.00", "₦14,500.00",
      "₦13,750.00", "₦13,000.00", "₦12,250.00", "₦11,500.00", "₦10,750.00",
    ]);
    expect(show(plan.totalInterest)).toBe("₦41,250.00");
    expect(show(plan.total)).toBe("₦141,250.00");
  });

  it("₦100,000 over 3 months puts the rounding in the last principal", () => {
    const plan = planSchedule({ ...terms, tenure: 3 });
    expect(plan.installments.map((i) => show(i.principal))).toEqual(["₦33,333.33", "₦33,333.33", "₦33,333.34"]);
    expect(show(plan.installments.reduce((s, i) => (s + i.principal) as Kobo, 0n as Kobo))).toBe("₦100,000.00");
  });

  it("anchors due dates to d0's day: 31 Jan → 28 Feb → 31 Mar → 30 Apr → 31 May", () => {
    const plan = planSchedule({ ...terms, tenure: 4, d0: d("2027-01-31") });
    expect(plan.installments.map((i) => i.dueDate)).toEqual(["2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
  });

  it("refuses ₦0 and tenures outside 1–12", () => {
    expect(() => planSchedule({ ...terms, principal: ngn("0") })).toThrow(/more than ₦0/);
    expect(() => planSchedule({ ...terms, tenure: 13 })).toThrow(/1 to 12/);
  });
});

describe("worked examples (PRD F6)", () => {
  it("A — on time: cycle 2 interest ₦6,750", () => {
    expect(interestOf([pay("2026-04-01", "17,500")], "2026-05-01", 2)).toBe("₦6,750.00");
  });

  it("B — late within the next cycle adds nothing", () => {
    const s = state([pay("2026-04-15", "17,500")], "2026-05-01");
    expect(show(s.installments[1]!.interest)).toBe("₦6,750.00");
    expect(s.installments[0]).toMatchObject({ interestPaid: ngn("7,500"), principalPaid: ngn("10,000") });
  });

  it("C — underpaid and not made up: interest on ₦95,000", () => {
    const p = [pay("2026-04-01", "12,500")];
    const s = state(p, "2026-05-02");
    expect(show(s.installments[1]!.interestBase)).toBe("₦95,000.00");
    expect(show(s.installments[1]!.interest)).toBe("₦7,125.00");
    expect(s.allocations.map((a) => [a.kind, a.installment, show(a.amount)])).toEqual([
      ["INTEREST", 1, "₦7,500.00"],
      ["PRINCIPAL", 1, "₦5,000.00"],
    ]);
  });

  it("D — underpaid, then made up inside the next cycle: no extra interest", () => {
    expect(interestOf([pay("2026-04-01", "12,500"), pay("2026-04-20", "5,000")], "2026-05-02", 2)).toBe("₦6,750.00");
  });

  it("E — overpaid: prepayment lowers interest from cycle 2 and is re-spread", () => {
    const s = state([pay("2026-04-01", "27,500")], "2026-04-02");
    const two = s.installments[1]!;
    expect(show(two.interest)).toBe("₦6,000.00");
    expect(show(two.principal)).toBe("₦8,888.89");
    expect(show((two.principal + two.interest) as Kobo)).toBe("₦14,888.89");
    expect(s.futurePrincipal.map((f) => show(f.principal))).toEqual([...Array(7).fill("₦8,888.89"), "₦8,888.88"]);
    expect(s.futurePrincipal.at(-1)!.dueDate).toBe("2027-01-01");
  });

  it("F — past the tenure: cycles continue on the principal still owed", () => {
    const plan = planSchedule(terms).installments;
    const p = plan.slice(0, 9).map((i) => ({ ...pay(i.dueDate, "1"), amount: i.amount }));
    p.push(pay("2027-01-01", "750")); // installment 10: interest only, ₦10,000 principal left
    const feb = state(p, "2027-02-01");
    expect(show(feb.outstandingPrincipal)).toBe("₦10,000.00");
    expect(show(feb.installments[10]!.interest)).toBe("₦750.00");
    const mar = state(p, "2027-03-02");
    expect(show(mar.installments[11]!.interest)).toBe("₦750.00");
    expect(mar.status).toBe("ACTIVE");
  });

  it("G / [AT-o] — payoff on the disbursement day costs ₦107,500; less never closes", () => {
    const paid = state([pay("2026-03-01", "107,500")], "2026-03-01");
    expect(paid).toMatchObject({ status: "CLOSED", closedOn: "2026-03-01" });
    expect(show(paid.interestCharged)).toBe("₦7,500.00");
    expect(show(payoffQuote(terms, [], d("2026-03-01"))!.amount)).toBe("₦107,500.00");
    const short = state([pay("2026-03-01", "100,000")], "2026-03-01");
    expect(short.status).toBe("ACTIVE");
    expect(show(short.outstandingPrincipal)).toBe("₦7,500.00");
  });

  it("H / [AT-s] — payoff quote mid-loan is ₦86,000, valid to the end of the cycle, and closes the loan", () => {
    const p = [pay("2026-04-01", "17,500"), pay("2026-05-01", "16,750")];
    const quote = payoffQuote(terms, p, d("2026-05-10"))!;
    expect(show(quote.amount)).toBe("₦86,000.00");
    expect(show(quote.principal)).toBe("₦80,000.00");
    expect(show(quote.interest)).toBe("₦6,000.00");
    expect(quote.validUntil).toBe("2026-06-01");
    const closed = state([...p, { ...pay("2026-05-10", "1"), amount: quote.amount }], "2026-05-10");
    expect(closed).toMatchObject({ status: "CLOSED", closedOn: "2026-05-10" });
    expect(show(closed.overpaymentCredit)).toBe("₦0.00");
    // Paid within the quote's validity (later in the same cycle), it still closes the loan.
    expect(state([...p, { ...pay("2026-06-01", "1"), amount: quote.amount }], "2026-06-01").status).toBe("CLOSED");
  });

  it("I / [AT-m] — a backdated catch-up posted late lowers cycle 2 interest; the diff moves the excess to principal", () => {
    const original = [pay("2026-04-01", "12,500"), pay("2026-05-15", "23,000")];
    const before = state(original, "2026-05-20");
    expect(show(before.installments[1]!.interest)).toBe("₦7,125.00");

    const late = pay("2026-04-20", "5,000"); // arrives on a schedule uploaded 20 May
    const after = state([...original, late], "2026-05-20");
    expect(show(after.installments[1]!.interest)).toBe("₦6,750.00");

    const { toReverse, toPost } = diffAllocations(before.allocations, after.allocations);
    expect(toReverse.some((a) => a.kind === "INTEREST" && a.installment === 2 && show(a.amount) === "₦7,125.00")).toBe(true);
    expect(toPost.some((a) => a.kind === "INTEREST" && a.installment === 2 && show(a.amount) === "₦6,750.00")).toBe(true);
    // Ledger interest income = interest actually paid, under the new state.
    const income = after.allocations.filter((a) => a.kind === "INTEREST").reduce((s, a) => s + a.amount, 0n);
    expect(income).toBe(after.interestPaid);
    // Every kobo of every payment is allocated exactly once.
    const total = after.allocations.reduce((s, a) => s + a.amount, 0n);
    expect(total).toBe([...original, late].reduce((s, p) => s + p.amount, 0n));
  });
});

describe("recompute properties", () => {
  it("is deterministic: the same payments in any arrival order give the same state", () => {
    const p = [pay("2026-04-01", "12,500"), pay("2026-04-20", "5,000"), pay("2026-05-15", "23,000"), pay("2026-05-15", "4,000"), pay("2026-07-30", "40,000")];
    const reference = JSON.stringify(state(p, "2026-09-01"), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2]]) {
      const shuffled = order.map((i) => p[i]!);
      expect(JSON.stringify(state(shuffled, "2026-09-01"), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(reference);
    }
  });

  it("never charges interest on unpaid interest (3 cycles with nothing paid)", () => {
    const s = state([], "2026-06-02");
    expect(s.installments.slice(0, 3).map((i) => show(i.interestBase))).toEqual(["₦100,000.00", "₦100,000.00", "₦100,000.00"]);
    expect(s.installments.slice(0, 3).map((i) => show(i.interest))).toEqual(["₦7,500.00", "₦7,500.00", "₦7,500.00"]);
    expect(show(s.interestArrears)).toBe("₦22,500.00");
  });

  it("reopens a closed loan when a payment is reversed (removed)", () => {
    const p = [pay("2026-03-01", "107,500")];
    expect(state(p, "2026-03-05").status).toBe("CLOSED");
    expect(state([], "2026-03-05").status).toBe("ACTIVE");
  });

  it("sends money paid after closure to the Overpayment Credit", () => {
    const s = state([pay("2026-03-01", "110,000"), pay("2026-04-10", "2,000")], "2026-04-10");
    expect(s.status).toBe("CLOSED");
    expect(show(s.overpaymentCredit)).toBe("₦4,500.00");
    expect(s.allocations.filter((a) => a.kind === "OVERPAYMENT").map((a) => show(a.amount))).toEqual(["₦2,500.00", "₦2,000.00"]);
  });

  it("marks the current cycle's interest provisional", () => {
    const s = state([pay("2026-04-01", "17,500")], "2026-04-15");
    expect(s.installments.map((i) => i.provisional)).toEqual([false, true]);
    expect(anniversary(terms.d0, s.currentCycle)).toBe("2026-05-01" as LocalDate);
  });

  it("refuses payments dated before disbursement", () => {
    expect(() => state([pay("2026-02-28", "1,000")], "2026-04-01")).toThrow(/before the disbursement date/);
  });
});
