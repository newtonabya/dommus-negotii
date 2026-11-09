import { parsePercentBps, parseSpreadsheetNaira } from "@/modules/credit/loans/legacy-import";

describe("legacy import parsing", () => {
  it("rounds spreadsheet amounts half up to the kobo, without floating point", () => {
    expect(parseSpreadsheetNaira("166666.6666666667")).toEqual({ kobo: 16_666_667n, rounded: true });
    expect(parseSpreadsheetNaira("150,000")).toEqual({ kobo: 15_000_000n, rounded: false });
    expect(parseSpreadsheetNaira("₦60,000.00")).toEqual({ kobo: 6_000_000n, rounded: false });
    expect(parseSpreadsheetNaira("100000.004")).toEqual({ kobo: 10_000_000n, rounded: true });
    expect(parseSpreadsheetNaira("100000.005")).toEqual({ kobo: 10_000_001n, rounded: true });
    expect(parseSpreadsheetNaira("abc")).toBeNull();
    expect(parseSpreadsheetNaira("-5")).toBeNull();
  });

  it("reads monthly percentages as basis points", () => {
    expect(parsePercentBps("7.5")).toBe(750);
    expect(parsePercentBps("7.55%")).toBe(755);
    expect(parsePercentBps("0")).toBe(0);
    expect(parsePercentBps("7.555")).toBeNull();
    expect(parsePercentBps("seven")).toBeNull();
  });
});
