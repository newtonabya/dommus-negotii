import { bankCodeFor, checkNuban, nubanValid } from "@/lib/nuban";

describe("NUBAN check digit", () => {
  it("accepts an account whose check digit fits the bank", () => {
    // The account on the staging voucher (Stanbic IBTC, CBN 221).
    expect(nubanValid("221", "9201929045")).toBe(true);
    expect(nubanValid("221", "9201929046")).toBe(false);
    // The walkthrough's First Bank account.
    expect(nubanValid("011", "3011122233")).toBe(true);
  });

  it("finds the bank from the name as typed, whole words only", () => {
    expect(bankCodeFor("Stanbic IBTC Bank")).toBe("221");
    expect(bankCodeFor("Guaranty Trust Bank (GTBank)")).toBe("058");
    expect(bankCodeFor("gtbank")).toBe("058");
    expect(bankCodeFor("United Bank for Africa (UBA)")).toBe("033");
    expect(bankCodeFor("First City Monument Bank (FCMB)")).toBe("214");
    expect(bankCodeFor("First Bank")).toBe("011");
    expect(bankCodeFor("Opay")).toBeNull();
    expect(bankCodeFor("Kuba Microfinance")).toBeNull();
  });

  it("says what it found: fits, doesn't fit (and which banks it would fit), or can't check", () => {
    expect(checkNuban("Stanbic IBTC Bank", "9201929045")).toEqual({ state: "ok", bank: "Stanbic IBTC Bank" });
    expect(checkNuban("Stanbic IBTC Bank", "92019")).toEqual({ state: "incomplete" });
    expect(checkNuban("Opay", "8012345678")).toEqual({ state: "unchecked" });
    const wrong = checkNuban("Zenith Bank", "9201929045");
    expect(wrong.state).toBe("mismatch");
    expect(wrong.state === "mismatch" && wrong.fitsBanks).toContain("Stanbic IBTC Bank");
    expect(checkNuban("Stanbic IBTC Bank", "9201 929 045").state).toBe("ok");
  });
});
