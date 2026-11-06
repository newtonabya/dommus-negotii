import ExcelJS from "exceljs";

/** Import limits: well above MOAUM's ~150 members, small enough for one request. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableError";
  }
}

export interface Table {
  headers: string[];
  /** Lines above the header row (e.g. a title such as "OCTOBER 2026 SALARY VOUCHER"). */
  preamble?: string[];
  /** Data rows, keyed by normalised header. `rowNo` is the spreadsheet row number. */
  rows: Array<{ rowNo: number; values: Record<string, string> }>;
}

/** "Full Name " → "full_name". */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new TableError("The CSV has an unclosed quote.");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export interface ReadOptions {
  /** A named sheet (any case) instead of the first. */
  sheet?: string;
  /** With `sheet`: a missing sheet gives an empty table instead of an error. */
  optional?: boolean;
  /** Finds the header row among the first 15 rows; rows above it become the preamble. Default: row 1. */
  isHeader?: (normalizedCells: string[]) => boolean;
}

function toTable(records: string[][], options: ReadOptions = {}): Table {
  let start = 0;
  if (options.isHeader) {
    const found = records.slice(0, 15).findIndex((r) => options.isHeader?.(r.map(normalizeHeader)));
    if (found >= 0) start = found;
  }
  const preamble = records.slice(0, start).map((r) => r.map((c) => c.trim()).filter(Boolean).join(" ")).filter(Boolean);
  const [headerRow, ...dataRows] = records.slice(start);
  if (!headerRow) throw new TableError("The file is empty.");
  const headers = headerRow.map(normalizeHeader);
  const rows: Table["rows"] = [];
  dataRows.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return; // skip blank lines
    const values: Record<string, string> = {};
    headers.forEach((h, col) => {
      if (h) values[h] = (cells[col] ?? "").trim();
    });
    rows.push({ rowNo: start + 2 + i, values });
  });
  if (rows.length > MAX_IMPORT_ROWS) throw new TableError(`The file has more than ${MAX_IMPORT_ROWS} rows.`);
  return { headers, rows, preamble };
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "result" in v) return String(v.result ?? ""); // formula
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  if (typeof v === "object" && "text" in v) return String(v.text); // hyperlink
  return cell.text ?? String(v);
}

/**
 * Reads a sheet of an .xlsx (the first, or the one named `sheet`, any case)
 * or a .csv file into a table. A named sheet missing from the workbook gives
 * an empty table when `optional`, otherwise an error.
 */
export async function readTable(filename: string, bytes: Uint8Array, options: ReadOptions = {}): Promise<Table> {
  if (bytes.length === 0) throw new TableError("The file is empty.");
  if (bytes.length > MAX_IMPORT_BYTES) throw new TableError("The file is larger than 2 MB.");
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TableError("Save the CSV as UTF-8 (Excel: Save As → CSV UTF-8).");
    }
    return toTable(parseCsv(text), options);
  }
  if (ext === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch {
      throw new TableError("This doesn't look like a valid Excel (.xlsx) file.");
    }
    const wanted = options.sheet?.toLowerCase();
    const sheet = wanted ? workbook.worksheets.find((w) => w.name.trim().toLowerCase() === wanted) : workbook.worksheets[0];
    if (!sheet) {
      if (wanted && options.optional) return { headers: [], rows: [] };
      throw new TableError(wanted ? `The workbook has no "${options.sheet}" sheet.` : "The workbook has no sheets.");
    }
    const records: string[][] = [];
    const width = sheet.columnCount;
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c)));
      records.push(cells);
    });
    return toTable(records, options);
  }
  throw new TableError("Upload a .xlsx or .csv file.");
}

/** Checks the file has every required column. */
export function assertColumns(table: Table, required: readonly string[]): void {
  const missing = required.filter((c) => !table.headers.includes(c));
  if (missing.length) throw new TableError(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the template.`);
}

export interface TemplateColumn {
  name: string;
  required: boolean;
  description: string;
  /** Keep as text in Excel (phone numbers, IDs) so leading zeros survive. */
  text?: boolean;
}

/** Builds an .xlsx template: a header row to fill in, and an Instructions sheet. */
export async function buildXlsxTemplate(
  title: string,
  columns: readonly TemplateColumn[],
  extraSheets: ReadonlyArray<{ title: string; columns: readonly TemplateColumn[] }> = [],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Dommus Negotii";
  const sheet = workbook.addWorksheet(title);
  sheet.columns = columns.map((c) => ({ header: c.name, key: c.name, width: Math.max(16, c.name.length + 4) }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  columns.forEach((c, i) => {
    if (c.text) sheet.getColumn(i + 1).numFmt = "@";
  });
  for (const extra of extraSheets) {
    const more = workbook.addWorksheet(extra.title);
    more.columns = extra.columns.map((c) => ({ header: c.name, key: c.name, width: Math.max(16, c.name.length + 4) }));
    more.getRow(1).font = { bold: true };
    extra.columns.forEach((c, i) => {
      if (c.text) more.getColumn(i + 1).numFmt = "@";
    });
  }
  const help = workbook.addWorksheet("Instructions");
  help.columns = [
    { header: "Column", key: "name", width: 26 },
    { header: "Required", key: "required", width: 10 },
    { header: "What to enter", key: "description", width: 80 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of [...columns, ...extraSheets.flatMap((e) => e.columns.map((x) => ({ ...x, name: `${e.title}: ${x.name}` })))]) {
    help.addRow({ name: c.name, required: c.required ? "Yes" : "No", description: c.description });
  }
  help.addRow({});
  help.addRow({ name: "Fill in the first sheet only, one person per row. Don't rename or reorder the header row." });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export function buildCsvTemplate(columns: readonly TemplateColumn[]): string {
  return `${columns.map((c) => c.name).join(",")}\r\n`;
}
