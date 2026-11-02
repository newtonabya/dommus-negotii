import { addDays, anniversary, cycleOf, daysBetween, localDate, todayInLagos } from "@/lib/dates";

const d = localDate;

describe("anniversary", () => {
  it("anchors to the disbursement day and clamps short months (PRD F6)", () => {
    const d0 = d("2026-01-31");
    expect([1, 2, 3, 4].map((k) => anniversary(d0, k))).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("handles leap years and year ends", () => {
    expect(anniversary(d("2027-01-31"), 1)).toBe("2027-02-28");
    expect(anniversary(d("2028-01-31"), 1)).toBe("2028-02-29");
    expect(anniversary(d("2026-03-01"), 10)).toBe("2027-01-01");
  });
});

describe("cycleOf", () => {
  const d0 = d("2026-03-01");

  it("puts the disbursement day and A1 in cycle 1", () => {
    expect(cycleOf(d0, d("2026-03-01"))).toBe(1);
    expect(cycleOf(d0, d("2026-04-01"))).toBe(1);
  });

  it("starts cycle 2 the day after A1", () => {
    expect(cycleOf(d0, d("2026-04-02"))).toBe(2);
    expect(cycleOf(d0, d("2026-04-15"))).toBe(2);
    expect(cycleOf(d0, d("2026-05-01"))).toBe(2);
  });

  it("continues past the tenure (cycle 11)", () => {
    expect(cycleOf(d0, d("2027-01-15"))).toBe(11);
  });

  it("works with clamped month ends", () => {
    const end = d("2026-01-31");
    expect(cycleOf(end, d("2026-02-28"))).toBe(1);
    expect(cycleOf(end, d("2026-03-01"))).toBe(2);
    expect(cycleOf(end, d("2026-03-31"))).toBe(2);
    expect(cycleOf(end, d("2026-04-01"))).toBe(3);
  });

  it("rejects dates before disbursement", () => {
    expect(() => cycleOf(d0, d("2026-02-28"))).toThrow(RangeError);
  });
});

describe("date helpers", () => {
  it("validates dates", () => {
    expect(() => localDate("2026-02-30")).toThrow(RangeError);
    expect(() => localDate("2026-2-3")).toThrow(SyntaxError);
  });

  it("adds and counts days across months", () => {
    expect(addDays(d("2026-02-27"), 3)).toBe("2026-03-02");
    expect(daysBetween(d("2026-03-01"), d("2026-04-01"))).toBe(31);
  });

  it("uses Lagos time for today (UTC+1)", () => {
    expect(todayInLagos(new Date("2026-11-02T23:30:00Z"))).toBe("2026-11-03");
    expect(todayInLagos(new Date("2026-11-02T22:59:00Z"))).toBe("2026-11-02");
  });
});
