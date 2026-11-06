import { monthFromTitle, voucherFromTable } from "@/modules/credit/remittance/payroll-voucher";

describe("payroll voucher", () => {
  it("reads the month from the title", () => {
    expect(monthFromTitle("OCTOBER 2026 SALARY VOUCHER")).toBe("2026-10");
    expect(monthFromTitle("Salary voucher for Sept 2026")).toBeNull();
    expect(monthFromTitle("SEP 2026 SALARY VOUCHER")).toBe("2026-09");
    expect(monthFromTitle("SALARY VOUCHER")).toBeNull();
  });

  it("finds the staff number and the MOAUM column, and skips the totals line", () => {
    const voucher = voucherFromTable({
      preamble: ["OCTOBER 2026 SALARY VOUCHER"],
      headers: ["s_no", "staff_name", "staff_no", "moaum_consultancy"],
      rows: [
        { rowNo: 3, values: { s_no: "839", staff_name: "PAUL  CHWADA       ", staff_no: " s03020", moaum_consultancy: "5375" } },
        { rowNo: 4, values: { s_no: "", staff_name: "TOTAL", staff_no: "", moaum_consultancy: "5375" } },
      ],
    });
    expect(voucher).toEqual({
      title: "OCTOBER 2026 SALARY VOUCHER",
      month: "2026-10",
      amountColumn: "moaum_consultancy",
      rows: [{ rowNo: 3, staffNo: "S03020", name: "PAUL CHWADA", amount: "5375" }],
    });
  });

  it("leaves template files alone and refuses an ambiguous amount column", () => {
    expect(voucherFromTable({ headers: ["member_moaum_id", "member_name", "amount"], rows: [] })).toBeNull();
    expect(() => voucherFromTable({ headers: ["staff_no", "staff_name", "basic", "tax"], rows: [] })).toThrow(/which column/);
  });
});
