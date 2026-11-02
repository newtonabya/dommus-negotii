import {
  applyRate,
  bps,
  divRoundHalfUp,
  formatNaira,
  fromJSON,
  kobo,
  parseNaira,
  spreadEvenly,
  toJSON,
} from "@/lib/money";

const RATE = bps(750n);

describe("divRoundHalfUp", () => {
  it("rounds halves up and everything else to nearest", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(5n, 3n)).toBe(2n);
  });

  it("rounds negative halves away from zero", () => {
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
  });
});

describe("applyRate", () => {
  it("charges 7.5% of ₦100,000 as ₦7,500", () => {
    expect(applyRate(parseNaira("100,000.00"), RATE)).toBe(parseNaira("7,500.00"));
  });

  it("charges 7.5% of ₦95,000 as ₦7,125 (PRD case C)", () => {
    expect(applyRate(parseNaira("95,000"), RATE)).toBe(parseNaira("7,125"));
  });

  it("rounds half a kobo up", () => {
    // 7.5% of 2 kobo = 0.15 kobo → 0; of 20 kobo = 1.5 kobo → 2
    expect(applyRate(kobo(2n), RATE)).toBe(0n);
    expect(applyRate(kobo(20n), RATE)).toBe(2n);
  });
});

describe("spreadEvenly", () => {
  it("splits ₦100,000 over 3 with the last absorbing the remainder", () => {
    const parts = spreadEvenly(parseNaira("100,000"), 3);
    expect(parts.map(formatNaira)).toEqual(["₦33,333.33", "₦33,333.33", "₦33,333.34"]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(10_000_000n);
  });

  it("re-spreads ₦80,000 over 9 as 8,888.89 × 8 + 8,888.88 (PRD case E)", () => {
    const parts = spreadEvenly(parseNaira("80,000"), 9);
    expect(parts.slice(0, 8).every((p) => p === parseNaira("8,888.89"))).toBe(true);
    expect(parts[8]).toBe(parseNaira("8,888.88"));
  });

  it("rejects zero parts", () => {
    expect(() => spreadEvenly(kobo(100n), 0)).toThrow(RangeError);
  });
});

describe("parseNaira and formatNaira", () => {
  it("round-trips en-NG amounts", () => {
    expect(formatNaira(parseNaira("₦141,250.00"))).toBe("₦141,250.00");
    expect(formatNaira(parseNaira("-500.5"))).toBe("-₦500.50");
    expect(formatNaira(kobo(7n))).toBe("₦0.07");
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["1,00.00", "12.345", "abc", "", "1e5"]) {
      expect(() => parseNaira(bad)).toThrow(SyntaxError);
    }
  });
});

describe("JSON form", () => {
  it("serialises as a kobo string", () => {
    expect(toJSON(kobo(14_125_000n))).toBe("14125000");
    expect(fromJSON("-50")).toBe(-50n);
    expect(() => fromJSON("1.5")).toThrow(SyntaxError);
  });
});
