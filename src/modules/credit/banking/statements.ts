import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { compareDates, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { sha256Hex } from "@/lib/hash";
import { formatNaira, kobo, parseNaira } from "@/lib/money";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { getDateSetting } from "@/shell/settings/settings";
import { normalizeHeader, readTable, type TemplateColumn } from "../imports/table";
import { ngn, tellStaff } from "../notices";

/** Messages from this error are written for the user and safe to show. */
export class BankError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "BankError";
  }
}

export interface BankActor {
  id: string;
  ipAddress: string | null;
}

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

const naira = (v: bigint) => formatNaira(kobo(v));
const toDb = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const fromDb = (d: Date) => localDate(d.toISOString().slice(0, 10));

/** Signed naira (a balance may be overdrawn): "-1,250.00" or "1,250.00 DR". */
function parseBalance(text: string): bigint {
  const t = text.trim().replace(/\s+/g, "");
  const dr = /DR$/i.test(t);
  const value = parseNaira(t.replace(/(CR|DR)$/i, "").replace(/^\((.*)\)$/, "-$1"));
  return dr ? -value : value;
}

// ───────────────────────────── Opening balances ─────────────────────────────

/** Admin uploads an account's balance at the go-live date, with the statement showing it. */
export async function uploadOpeningBalance(
  db: PrismaClient,
  store: EvidenceStore,
  actor: BankActor,
  input: { bankAccountId: string; asOf: string; amount: string },
  evidence: UploadedFile,
) {
  const account = await db.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account) throw new BankError("Choose the bank account.");
  let asOf: LocalDate;
  try {
    asOf = localDate(input.asOf.trim());
  } catch {
    throw new BankError("Enter the date of the balance.");
  }
  if (compareDates(asOf, todayInLagos()) > 0) throw new BankError("The balance date can't be in the future.");
  const goLive = await getDateSetting(db, "go_live_date");
  if (goLive && asOf !== goLive) throw new BankError(`Opening balances are as at the go-live date, ${goLive}.`);
  let amount: bigint;
  try {
    amount = parseNaira(input.amount);
  } catch {
    throw new BankError("Enter the balance in naira, e.g. 1,250,000.00.");
  }
  if (amount < 0n) throw new BankError("An overdrawn opening balance isn't supported; contact the developer.");
  if (evidence.bytes.length === 0) throw new BankError("Attach the bank statement that shows the balance.");
  const live = await db.bankOpeningBalance.findFirst({ where: { bankAccountId: account.id, status: { not: "REJECTED" } } });
  if (live) throw new BankError(`${account.bankName} ${account.accountNumber} already has an opening balance ${live.status === "COMMITTED" ? "committed" : "waiting for the Finance Manager"}.`);
  const file = await storeEvidenceBytes(db, store, actor, evidence.filename, evidence.bytes);
  const opening = await db.bankOpeningBalance.create({
    data: { bankAccountId: account.id, asOf: toDb(asOf), amount, evidenceId: file.evidenceId, uploadedById: actor.id },
  });
  await writeAudit(db, {
    action: "bankOpening.upload",
    entityType: "BankOpeningBalance",
    entityId: opening.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    evidenceRef: file.evidenceId,
    after: { account: account.accountNumber, asOf, amount: amount.toString() },
  });
  await tellStaff(db, ["FINANCE_MANAGER"], `opening.uploaded:${opening.id}`, "staff.opening.uploaded", "An opening balance waits to be committed", `The go-live opening balance for ${account.bankName} ${account.accountNumber} (${ngn(amount)}) was uploaded and waits for you to commit it.`, actor.id);
  return opening;
}

async function preparedOpening(db: Db, id: string, actor: BankActor) {
  const opening = await db.bankOpeningBalance.findUnique({ where: { id } });
  if (!opening) throw new BankError("Opening balance not found.");
  if (opening.status !== "PREPARED") throw new BankError("This opening balance has already been decided.");
  if (opening.uploadedById === actor.id) throw new BankError("Someone other than the uploader must commit it.");
  return opening;
}

/** Finance Manager commits it: OPENING_BALANCE (cash, bank account, source LEGACY_IMPORT). */
export async function commitOpeningBalance(db: PrismaClient, actor: BankActor, id: string) {
  const opening = await preparedOpening(db, id, actor);
  await db.$transaction(async (tx) => {
    const { count } = await tx.bankOpeningBalance.updateMany({ where: { id, status: "PREPARED" }, data: { status: "COMMITTED", decidedById: actor.id, decidedAt: new Date() } });
    if (count !== 1) throw new BankError("This opening balance was decided by someone else just now.");
    const { event } = await postEvent(tx, {
      occurredAt: opening.asOf,
      moduleCode: "CREDIT",
      eventType: "OPENING_BALANCE",
      source: "LEGACY_IMPORT",
      evidenceRefs: [opening.evidenceId],
      portalUserId: actor.id,
      moduleEntityType: "BankAccount",
      moduleEntityId: opening.bankAccountId,
      bankAccountId: opening.bankAccountId,
      cashAmount: opening.amount,
      uniquenessKey: `CREDIT:OPENING_BALANCE:${opening.bankAccountId}`,
      metadata: { openingBalanceId: opening.id, asOf: fromDb(opening.asOf) },
    });
    await tx.bankOpeningBalance.update({ where: { id }, data: { ledgerEventId: event.id } });
    await linkEvidence(tx, actor, { evidenceId: opening.evidenceId, entityType: "BankOpeningBalance", entityId: id, kind: "PRIMARY", submissionKey: `BANK_OPENING:${id}` });
    await writeAudit(tx, {
      action: "bankOpening.commit",
      entityType: "BankOpeningBalance",
      entityId: id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: opening.evidenceId,
      after: { amount: opening.amount.toString(), ledgerEventId: event.id },
    });
  }, TX_OPTIONS);
}

export async function rejectOpeningBalance(db: Db, actor: BankActor, id: string, reason: string) {
  const text = reason.trim();
  if (text.length < 5) throw new BankError("Say why it is rejected.");
  await preparedOpening(db, id, actor);
  const { count } = await db.bankOpeningBalance.updateMany({ where: { id, status: "PREPARED" }, data: { status: "REJECTED", decidedById: actor.id, decidedAt: new Date(), rejectReason: text } });
  if (count !== 1) throw new BankError("This opening balance was decided by someone else just now.");
  await writeAudit(db, { action: "bankOpening.reject", entityType: "BankOpeningBalance", entityId: id, userId: actor.id, ipAddress: actor.ipAddress, after: { reason: text } });
}

// ───────────────────────────── Statement template and mapping ─────────────────────────────

/** The standard MOAUM statement template (PRD F10). */
export const STATEMENT_COLUMNS: readonly TemplateColumn[] = [
  { name: "transaction_date", required: true, text: true, description: "Date of the transaction (YYYY-MM-DD, or as set in the account's mapping)." },
  { name: "value_date", required: false, text: true, description: "Value date, if the bank shows one." },
  { name: "reference", required: false, text: true, description: "Transaction reference or cheque number." },
  { name: "narration", required: true, description: "Description / narration as on the statement." },
  { name: "debit", required: false, description: "Money out, in naira. Leave empty for credits." },
  { name: "credit", required: false, description: "Money in, in naira. Leave empty for debits." },
  { name: "balance", required: false, description: "Running balance after the line, if the bank shows one." },
];

export type StatementField = "transaction_date" | "value_date" | "reference" | "narration" | "debit" | "credit" | "balance";
export const STATEMENT_FIELDS: StatementField[] = ["transaction_date", "value_date", "reference", "narration", "debit", "credit", "balance"];
export type DateFormat = "ISO" | "DMY" | "MDY";

export interface ColumnMapping {
  /** Our field → the bank's column header (as printed). Unmapped fields use the template name. */
  fields: Partial<Record<StatementField, string>>;
  dateFormat: DateFormat;
}

const DEFAULT_MAPPING: ColumnMapping = { fields: {}, dateFormat: "ISO" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A statement date in the account's format; spreadsheet date cells always arrive as YYYY-MM-DD. */
export function parseBankDate(text: string, format: DateFormat): LocalDate | null {
  const t = text.trim();
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return localDate(t);
    const named = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})$/.exec(t);
    if (named) {
      const m = MONTHS.indexOf(named[2]!.toLowerCase());
      if (m < 0) return null;
      const y = named[3]!.length === 2 ? `20${named[3]}` : named[3]!;
      return localDate(`${y}-${String(m + 1).padStart(2, "0")}-${named[1]!.padStart(2, "0")}`);
    }
    const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
    if (parts && format !== "ISO") {
      const [a, b] = format === "DMY" ? [parts[1]!, parts[2]!] : [parts[2]!, parts[1]!];
      const y = parts[3]!.length === 2 ? `20${parts[3]}` : parts[3]!;
      return localDate(`${y}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`);
    }
  } catch {
    return null;
  }
  return null;
}

export async function getMapping(db: Db, bankAccountId: string): Promise<ColumnMapping> {
  const saved = await db.statementMapping.findUnique({ where: { bankAccountId } });
  return saved ? (saved.mapping as unknown as ColumnMapping) : DEFAULT_MAPPING;
}

/** Finance Manager saves how this bank's export maps onto the template; reused for every statement. */
export async function saveMapping(db: Db, actor: BankActor, bankAccountId: string, mapping: ColumnMapping) {
  const fields: ColumnMapping["fields"] = {};
  for (const f of STATEMENT_FIELDS) {
    const v = mapping.fields[f]?.trim();
    if (v) fields[f] = v.slice(0, 80);
  }
  if (!["ISO", "DMY", "MDY"].includes(mapping.dateFormat)) throw new BankError("Choose the date format.");
  const value = { fields, dateFormat: mapping.dateFormat } as unknown as Prisma.InputJsonValue;
  const before = await db.statementMapping.findUnique({ where: { bankAccountId } });
  await db.statementMapping.upsert({ where: { bankAccountId }, create: { bankAccountId, mapping: value, updatedById: actor.id }, update: { mapping: value, updatedById: actor.id } });
  await writeAudit(db, { action: "statementMapping.save", entityType: "BankAccount", entityId: bankAccountId, userId: actor.id, ipAddress: actor.ipAddress, before: before?.mapping ?? null, after: value });
}

// ───────────────────────────── Statement import ─────────────────────────────

export interface ParsedLine {
  rowNo: number;
  transactionDate: LocalDate;
  valueDate: LocalDate | null;
  direction: "CREDIT" | "DEBIT";
  amount: bigint;
  reference: string;
  narration: string;
  runningBalance: bigint | null;
}

/** Reads statement lines through the account's mapping; every problem is listed. */
export async function parseStatementFile(file: UploadedFile, mapping: ColumnMapping) {
  const column = (f: StatementField) => normalizeHeader(mapping.fields[f] ?? f);
  const table = await readTable(file.filename, file.bytes, { isHeader: (cells) => cells.includes(column("transaction_date")) });
  const errors: string[] = [];
  for (const f of ["transaction_date", "narration"] as const) {
    if (!table.headers.includes(column(f))) errors.push(`The file has no "${mapping.fields[f] ?? f}" column. Check the account's column mapping.`);
  }
  if (!table.headers.includes(column("debit")) && !table.headers.includes(column("credit"))) errors.push("The file has no debit or credit column. Check the account's column mapping.");
  if (errors.length) throw new BankError("The statement can't be read:", errors);

  const lines: ParsedLine[] = [];
  for (const { rowNo, values } of table.rows) {
    const get = (f: StatementField) => (values[column(f)] ?? "").trim();
    const dateText = get("transaction_date");
    const debitText = get("debit");
    const creditText = get("credit");
    // Skip balance brought forward / totals lines with no movement.
    if (!debitText && !creditText) continue;
    const date = parseBankDate(dateText, mapping.dateFormat);
    if (!date) {
      errors.push(`Row ${rowNo}: "${dateText}" is not a date in the account's format (${mapping.dateFormat}).`);
      continue;
    }
    let debit = 0n;
    let credit = 0n;
    try {
      debit = debitText ? parseNaira(debitText.replace(/\s/g, "")) : 0n;
      credit = creditText ? parseNaira(creditText.replace(/\s/g, "")) : 0n;
    } catch {
      errors.push(`Row ${rowNo}: the debit or credit is not an amount.`);
      continue;
    }
    if (debit < 0n || credit < 0n || (debit > 0n && credit > 0n) || debit + credit === 0n) {
      errors.push(`Row ${rowNo}: enter either a debit or a credit, more than ₦0.`);
      continue;
    }
    let runningBalance: bigint | null = null;
    if (get("balance")) {
      try {
        runningBalance = parseBalance(get("balance"));
      } catch {
        errors.push(`Row ${rowNo}: the balance is not an amount.`);
        continue;
      }
    }
    lines.push({
      rowNo,
      transactionDate: date,
      valueDate: get("value_date") ? parseBankDate(get("value_date"), mapping.dateFormat) : null,
      direction: credit > 0n ? "CREDIT" : "DEBIT",
      amount: credit > 0n ? credit : debit,
      reference: get("reference").slice(0, 120),
      narration: get("narration").slice(0, 500),
      runningBalance,
    });
  }
  return { lines, errors };
}

/** Line identity (PRD F10): account + date + direction + amount + reference + running balance; repeats in one file are numbered. */
export function lineKeys(bankAccountId: string, lines: ParsedLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = [bankAccountId, l.transactionDate, l.direction, l.amount.toString(), l.reference.toUpperCase(), l.runningBalance?.toString() ?? ""].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

export interface StatementInput {
  bankAccountId: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: string;
  closingBalance: string;
}

/**
 * Finance Manager imports a monthly statement (PRD F10). Its opening balance
 * must continue the previous statement's closing balance (the first continues
 * the committed go-live opening balance), its lines must add up from opening
 * to closing, and lines already imported from an overlapping statement are
 * skipped, never duplicated.
 */
export async function importStatement(db: PrismaClient, store: EvidenceStore, actor: BankActor, input: StatementInput, file: UploadedFile) {
  const account = await db.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account) throw new BankError("Choose the bank account.");
  const from = parseBankDate(input.periodFrom, "ISO");
  const to = parseBankDate(input.periodTo, "ISO");
  if (!from || !to || compareDates(from, to) > 0) throw new BankError("Enter the statement period (from and to).");
  if (compareDates(to, todayInLagos()) > 0) throw new BankError("The statement period can't end in the future.");
  let opening: bigint;
  let closing: bigint;
  try {
    opening = parseBalance(input.openingBalance);
    closing = parseBalance(input.closingBalance);
  } catch {
    throw new BankError("Enter the statement's opening and closing balances in naira.");
  }

  const [goLiveBalance, previous] = await Promise.all([
    db.bankOpeningBalance.findFirst({ where: { bankAccountId: account.id, status: "COMMITTED" } }),
    db.bankStatement.findFirst({ where: { bankAccountId: account.id }, orderBy: { periodTo: "desc" } }),
  ]);
  if (!goLiveBalance) throw new BankError("Commit this account's go-live opening balance before importing statements.");
  const startsAfter = previous ? fromDb(previous.periodTo) : fromDb(goLiveBalance.asOf);
  if (compareDates(to, startsAfter) <= 0) throw new BankError(`This period ends on or before ${startsAfter}, which is already covered.`);

  const { lines, errors } = await parseStatementFile(file, await getMapping(db, account.id));
  for (const l of lines) {
    if (compareDates(l.transactionDate, from) < 0 || compareDates(l.transactionDate, to) > 0) errors.push(`Row ${l.rowNo}: ${l.transactionDate} is outside the period ${from} to ${to}.`);
  }
  const movement = lines.reduce((t, l) => t + (l.direction === "CREDIT" ? l.amount : -l.amount), 0n);
  if (errors.length === 0 && opening + movement !== closing) {
    errors.push(`Opening ${naira(opening)} plus the lines (${naira(movement)}) gives ${naira(opening + movement)}, not the closing balance ${naira(closing)}.`);
  }
  if (errors.length) throw new BankError("The statement was not imported. Fix these and try again:", errors);

  const keys = lineKeys(account.id, lines);
  const existing = new Set((await db.bankStatementLine.findMany({ where: { uniquenessKey: { in: keys } }, select: { uniquenessKey: true } })).map((l) => l.uniquenessKey));
  const fresh = lines.map((l, i) => ({ l, key: keys[i]! })).filter(({ key }) => !existing.has(key));

  // Continuity: after the lines already imported (an overlap), the balance must be where the last statement closed.
  const expected = previous ? previous.closingBalance : goLiveBalance.amount;
  const overlap = lines.filter((_, i) => existing.has(keys[i]!)).reduce((t, l) => t + (l.direction === "CREDIT" ? l.amount : -l.amount), 0n);
  if (opening + overlap !== expected) {
    throw new BankError(
      `The statement's opening balance ${naira(opening)}${overlap ? ` plus the ${naira(overlap)} already imported` : ""} doesn't continue ${previous ? `the previous statement's closing balance (to ${fromDb(previous.periodTo)})` : "the go-live opening balance"} of ${naira(expected)}. Import the missing statement first.`,
    );
  }
  const evidence = await storeEvidenceBytes(db, store, actor, file.filename, file.bytes);

  return db.$transaction(async (tx) => {
    const statement = await tx.bankStatement.create({
      data: {
        bankAccountId: account.id,
        periodFrom: toDb(from),
        periodTo: toDb(to),
        openingBalance: opening,
        closingBalance: closing,
        evidenceId: evidence.evidenceId,
        checksum: sha256Hex(file.bytes),
        lineCount: fresh.length,
        skippedCount: lines.length - fresh.length,
        uploadedById: actor.id,
      },
    });
    if (fresh.length) {
      await tx.bankStatementLine.createMany({
        data: fresh.map(({ l, key }) => ({
          statementId: statement.id,
          bankAccountId: account.id,
          transactionDate: toDb(l.transactionDate),
          valueDate: l.valueDate ? toDb(l.valueDate) : null,
          direction: l.direction,
          amount: l.amount,
          reference: l.reference,
          narration: l.narration,
          runningBalance: l.runningBalance,
          uniquenessKey: key,
        })),
      });
    }
    await linkEvidence(tx, actor, { evidenceId: evidence.evidenceId, entityType: "BankStatement", entityId: statement.id, kind: "PRIMARY", submissionKey: `BANK_STATEMENT:${statement.id}` });
    await writeAudit(tx, {
      action: "bankStatement.upload",
      entityType: "BankStatement",
      entityId: statement.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: evidence.evidenceId,
      after: { account: account.accountNumber, from, to, opening: opening.toString(), closing: closing.toString(), lines: fresh.length, skipped: lines.length - fresh.length, checksum: evidence.sha256 },
    });
    return statement;
  }, { maxWait: 15_000, timeout: 120_000 });
}

/** Per account: the opening balance, the saved mapping and the statements, newest first. */
export async function bankOverview(db: Db) {
  const accounts = await db.bankAccount.findMany({
    orderBy: [{ active: "desc" }, { bankName: "asc" }],
    include: {
      openings: { where: { status: { not: "REJECTED" } } },
      mapping: true,
      statements: { orderBy: { periodTo: "desc" }, take: 12 },
    },
  });
  return accounts.map((a) => ({ ...a, opening: a.openings[0] ?? null, mapping: a.mapping ? (a.mapping.mapping as unknown as ColumnMapping) : null }));
}
