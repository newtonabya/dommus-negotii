import { maskName, receiptCode, receiptNumber, receiptToken } from "@/modules/credit/reports/member-documents";

describe("receipts", () => {
  beforeAll(() => {
    process.env.RECEIPT_SECRET = "unit-test-secret";
  });

  it("masks member names on the public page", () => {
    expect(maskName("Amina Bello")).toBe("A***a B***o");
    expect(maskName("  Ade  Okonkwo-Eze ")).toBe("A*e O***e");
    expect(maskName("Jo")).toBe("J*");
  });

  it("signs receipts so a changed id or code doesn't verify", () => {
    const id = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";
    expect(receiptCode(id)).toHaveLength(12);
    expect(receiptCode(id)).toBe(receiptCode(id));
    expect(receiptCode(id)).not.toBe(receiptCode(id.replace("7", "8")));
    expect(receiptToken(id)).toBe(`${id}.${receiptCode(id)}`);
    expect(receiptNumber("SCH-OCT-26", 7)).toBe("RC-SCH-OCT-26-007");
  });
});
