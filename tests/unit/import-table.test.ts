import ExcelJS from "exceljs";
import { assertColumns, buildCsvTemplate, buildXlsxTemplate, normalizeHeader, parseCsv, readTable, TableError } from "@/modules/credit/imports/table";
import { MEMBER_COLUMNS } from "@/modules/credit/imports/templates";
import { normalizeNigerianPhone } from "@/shell/auth/phone";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("CSV parsing (PRD F5 imports)", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines, CRLF and a BOM", () => {
    const text = '﻿full_name,address\r\n"Obi, Ada","12 ""Allen"" Ave\nIkeja"\r\nChidi,Lagos';
    expect(parseCsv(text)).toEqual([
      ["full_name", "address"],
      ["Obi, Ada", '12 "Allen" Ave\nIkeja'],
      ["Chidi", "Lagos"],
    ]);
  });

  it("rejects an unclosed quote", () => {
    expect(() => parseCsv('a,"b\nc')).toThrow(TableError);
  });

  it("normalises headers", () => {
    expect(normalizeHeader(" Full Name ")).toBe("full_name");
    expect(normalizeHeader("MOAUM ID-Number")).toBe("moaum_id_number");
  });
});

describe("readTable", () => {
  it("keys rows by header, numbers them as in the spreadsheet and skips blank lines", async () => {
    const table = await readTable("list.csv", utf8("Full Name,Phone\nAda Obi, 0803 123 4567 \n,\nChidi Eze,08031234568\n"));
    expect(table.headers).toEqual(["full_name", "phone"]);
    expect(table.rows).toEqual([
      { rowNo: 2, values: { full_name: "Ada Obi", phone: "0803 123 4567" } },
      { rowNo: 4, values: { full_name: "Chidi Eze", phone: "08031234568" } },
    ]);
  });

  it("refuses non-UTF-8 CSV, unknown types and missing columns", async () => {
    await expect(readTable("list.csv", new Uint8Array([0x61, 0xff, 0x0a]))).rejects.toThrow(/UTF-8/);
    await expect(readTable("list.pdf", utf8("x"))).rejects.toThrow(/xlsx or \.csv/);
    await expect(readTable("list.xlsx", utf8("not a zip"))).rejects.toThrow(/valid Excel/);
    const table = await readTable("list.csv", utf8("full_name\nAda"));
    expect(() => assertColumns(table, ["full_name", "phone"])).toThrow(/phone/);
  });

  it("reads Excel cells typed as numbers, dates, formulas and rich text", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Members");
    sheet.addRow(["full_name", "phone", "joined", "code"]);
    sheet.addRow([{ richText: [{ text: "Ada " }, { text: "Obi" }] }, 8031234567, new Date(Date.UTC(2020, 0, 15)), { formula: '"PAY"&"-A"', result: "PAY-A" }]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const table = await readTable("members.xlsx", bytes);
    expect(table.rows).toEqual([{ rowNo: 2, values: { full_name: "Ada Obi", phone: "8031234567", joined: "2020-01-15", code: "PAY-A" } }]);
    // The leading zero Excel dropped is restored.
    expect(normalizeNigerianPhone(table.rows[0]?.values.phone ?? "")).toBe("+2348031234567");
  });

  it("reads back its own templates with every column and no rows", async () => {
    const names = MEMBER_COLUMNS.map((c) => c.name);
    const xlsx = await readTable("members.xlsx", await buildXlsxTemplate("Members", MEMBER_COLUMNS));
    expect(xlsx).toEqual({ headers: names, rows: [] });
    const csv = await readTable("members.csv", utf8(buildCsvTemplate(MEMBER_COLUMNS)));
    expect(csv.headers).toEqual(names);
  });
});

describe("phone numbers from spreadsheets", () => {
  it("accepts a 10-digit number without the leading zero, but nothing shorter", () => {
    expect(normalizeNigerianPhone("8031234567")).toBe("+2348031234567");
    expect(normalizeNigerianPhone("7011234567")).toBe("+2347011234567");
    expect(normalizeNigerianPhone("803123456")).toBeNull();
    expect(normalizeNigerianPhone("6031234567")).toBeNull();
  });
});
