import { readTable, type Table } from "../imports/table";
import { RemittanceError } from "./common";

/**
 * The payroll office's salary voucher, uploaded exactly as it arrives, e.g.
 *
 *   Rev. Fr. Moses Orshio Adasu University, Makurdi      (optional lines above the title)
 *   OCTOBER 2026 SALARY VOUCHER
 *   S/NO | STAFF NAME | STAFF NO | MOAUM CONSULTANCY       (blank or merged columns are fine)
 *   839  | PAUL …     | S03020   | 5375
 *
 * Members are matched on their payroll staff number (recorded on the member
 * when they are created) or, once payroll quotes it, the system member number.
 */
export interface PayrollVoucher {
  title: string | null;
  /** YYYY-MM read from the title, when it names a month and year. */
  month: string | null;
  amountColumn: string;
  rows: Array<{ rowNo: number; staffNo: string; name: string; amount: string }>;
}

const STAFF_NO = ["staff_no", "staff_number", "staffno", "payroll_no", "payroll_number", "member_no"];
const NAME = ["staff_name", "name", "full_name", "member_name"];
const IGNORED = ["s_no", "sno", "s_n", "serial_no", "sn", "no"];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "OCTOBER 2026 SALARY VOUCHER" → "2026-10". */
export function monthFromTitle(title: string): string | null {
  const text = title.toLowerCase();
  const year = /\b(20\d{2})\b/.exec(text)?.[1];
  const index = MONTHS.findIndex((m) => new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(text));
  return year && index >= 0 ? `${year}-${String(index + 1).padStart(2, "0")}` : null;
}

const isVoucherHeader = (cells: string[]) => cells.some((c) => STAFF_NO.includes(c)) && !cells.includes("member_moaum_id");

/** Turns a read table into a voucher, or null when it isn't in the voucher layout. */
export function voucherFromTable(table: Table): PayrollVoucher | null {
  const staffCol = table.headers.find((h) => STAFF_NO.includes(h));
  if (!staffCol || table.headers.includes("member_moaum_id")) return null;
  const nameCol = table.headers.find((h) => NAME.includes(h));
  const others = table.headers.filter((h) => h && h !== staffCol && h !== nameCol && !IGNORED.includes(h));
  const amountColumn = others.length === 1 ? others[0] : others.find((h) => h.includes("moaum"));
  if (!amountColumn) {
    throw new RemittanceError(`Can't tell which column holds the MOAUM deduction. Columns found: ${table.headers.filter(Boolean).join(", ")}.`);
  }
  // The lines above the header may start with the employer's name; the title is the one that names the month.
  const lines = table.preamble ?? [];
  const title = lines.find((l) => monthFromTitle(l)) ?? lines[0] ?? null;
  const rows: PayrollVoucher["rows"] = [];
  for (const { rowNo, values } of table.rows) {
    const staffNo = (values[staffCol] ?? "").replace(/\s+/g, "").toUpperCase();
    const name = (values[nameCol ?? ""] ?? "").replace(/\s+/g, " ").trim();
    const amount = (values[amountColumn] ?? "").trim();
    // A totals line ("TOTAL", no staff number) is not a member row.
    if (!staffNo && (/total/i.test(Object.values(values).join(" ")) || !amount)) continue;
    rows.push({ rowNo, staffNo, name, amount });
  }
  return { title, month: title ? monthFromTitle(title) : null, amountColumn, rows };
}

/** Reads an uploaded file as a payroll voucher; null when it uses the template layout instead. */
export async function readPayrollVoucher(filename: string, bytes: Uint8Array): Promise<PayrollVoucher | null> {
  const table = await readTable(filename, bytes, { isHeader: isVoucherHeader });
  return voucherFromTable(table);
}

/** Normalised payroll staff number, as stored on the member. */
export const normalizeStaffNo = (value: string) => value.replace(/\s+/g, "").toUpperCase();
