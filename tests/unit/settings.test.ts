import { bps } from "@/lib/money";
import { definitionOf, formatPercent, formatValue, parseInput, parsePercent, SETTINGS } from "@/shell/settings/definitions";

const def = (key: string) => {
  const d = definitionOf(key);
  if (!d) throw new Error(key);
  return d;
};

describe("rates as percentages (PRD F2, F6)", () => {
  it("parses percentages into basis points without floats", () => {
    expect(parsePercent("7.5")).toBe(750n);
    expect(parsePercent("7.50%")).toBe(750n);
    expect(parsePercent("12")).toBe(1200n);
    expect(parsePercent(" 0.25 ")).toBe(25n);
    expect(() => parsePercent("7.555")).toThrow();
    expect(() => parsePercent("-1")).toThrow();
    expect(() => parsePercent("abc")).toThrow();
  });

  it("formats basis points back", () => {
    expect(formatPercent(bps(750n))).toBe("7.5%");
    expect(formatPercent(bps(1200n))).toBe("12%");
    expect(formatPercent(bps(25n))).toBe("0.25%");
  });
});

describe("settings registry", () => {
  it("marks exactly the PRD's financial settings as needing approval", () => {
    expect(SETTINGS.filter((s) => s.financial).map((s) => s.key)).toEqual([
      "interest_rate_bps",
      "go_live_date",
      "reconciliation_window_days",
      "max_open_loans_per_member",
      "max_open_guarantees_per_guarantor",
    ]);
  });

  it("uses the PRD defaults", () => {
    expect(formatValue(def("interest_rate_bps"), "750")).toBe("7.5%");
    expect(def("reconciliation_window_days").default).toBe(3);
    expect(def("max_open_loans_per_member").default).toBe(2);
    expect(def("max_open_guarantees_per_guarantor").default).toBe(2);
    expect(def("go_live_date").default).toBeNull();
    expect(def("invitation_ttl_days").default).toBe(7);
  });

  it("checks typed input against each setting's range", () => {
    expect(parseInput(def("interest_rate_bps"), "8")).toEqual({ value: "800" });
    expect(parseInput(def("interest_rate_bps"), "51")).toHaveProperty("error");
    expect(parseInput(def("max_open_loans_per_member"), "3")).toEqual({ value: 3 });
    expect(parseInput(def("max_open_loans_per_member"), "0")).toHaveProperty("error");
    expect(parseInput(def("max_open_loans_per_member"), "2.5")).toHaveProperty("error");
    expect(parseInput(def("go_live_date"), "2027-01-01")).toEqual({ value: "2027-01-01" });
    expect(parseInput(def("go_live_date"), "2027-02-30")).toHaveProperty("error");
  });
});
