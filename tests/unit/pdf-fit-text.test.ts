import { fitText } from "@/lib/pdf";

/** One unit per character, so the expected cut is easy to see. */
const width = (s: string) => s.length;

describe("fitText (PDF cells)", () => {
  it("keeps text that fits", () => {
    expect(fitText("ledger", 6, width)).toBe("ledger");
    expect(fitText("", 0, width)).toBe("");
  });

  it("cuts to the longest start that fits with the ellipsis", () => {
    expect(fitText("CREDIT:ALLOC:row-1", 8, width)).toBe("CREDIT:…");
    expect(fitText("abcdef", 5, width)).toBe("abcd…");
  });

  it("leaves only the ellipsis when nothing else fits", () => {
    expect(fitText("abcdef", 1, width)).toBe("…");
    expect(fitText("abcdef", 0, width)).toBe("…");
  });

  it("measures far fewer times than once per character", () => {
    let calls = 0;
    const long = "x".repeat(5_000);
    const out = fitText(long, 100, (s) => {
      calls++;
      return s.length;
    });
    expect(out).toBe(`${"x".repeat(99)}…`);
    expect(calls).toBeLessThan(20);
  });
});
