import { scrub } from "@/lib/scrub";

describe("scrubbing personal data from logs (PRD §5)", () => {
  it("removes emails, phone numbers, link tokens and secrets", () => {
    const line =
      "Failed for ada.obi@example.com on +2348031234567 / 08031234567 at /join/AbCdEfGhIjKlMnOpQrStUv?token=xyz&page=2 key Xq7Lm2Vp9Rt4Nw8Kc3Hb6Jd1Fg5Zs0Ya";
    expect(scrub(line)).toBe("Failed for [email] on [phone] / [phone] at /join/[token]?token=[redacted]&page=2 key [secret]");
  });

  it("leaves ordinary text alone", () => {
    expect(scrub("Loan CSS-2026-00042 not found (amount 150000)")).toBe("Loan CSS-2026-00042 not found (amount 150000)");
  });
});
