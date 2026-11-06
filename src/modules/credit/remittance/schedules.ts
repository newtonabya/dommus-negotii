import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { compareDates, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { rowHash } from "@/lib/hash";
import { kobo, ZERO, type Kobo } from "@/lib/money";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { getDateSetting } from "@/shell/settings/settings";
import { flagDuplicates, loadPreviewedBatch, saveBatch, type PreviewRow } from "../imports/batches";
import { assertColumns, readTable } from "../imports/table";
import { LODGEMENT_COLUMNS, SCHEDULE_ROW_COLUMNS } from "../imports/templates";
import { fromDbDate } from "../loans/common";
import { applyRecompute, planRecompute } from "../loans/repayments";
import { activeSource, membersByPayrollKey, monthEnd, naira, parseCount, parseMonth, positiveAmount, REMITTANCE_TX, RemittanceError, type RemittanceActor } from "./common";
import { normalizeStaffNo, readPayrollVoucher } from "./payroll-voucher";
import type { UploadedFile } from "./source-advice";

export interface ScheduleHeaderInput {
  scheduleReference: string;
  remittanceSource: string;
  monthCovered: string;
  scheduleType: string;
  adviceReference: string;
  submittedBy: string;
  controlTotal: string;
  rowCount: string;
  /** For a payroll voucher, which has no dates: the day salaries were paid. */
  paymentDate?: string;
}

export interface ScheduleHeader {
  scheduleReference: string;
  remittanceSourceId: string;
  sourceCode: string;
  monthCovered: string;
  type: "REGULAR" | "SUPPLEMENTARY";
  adviceReference: string;
  submittedBy: string;
  /** Kobo, as a string. */
  controlTotal: string;
  rowCount: number;
}

/** One schedule row as it will be posted. Money in kobo strings (JSON). */
export interface ScheduleRowPlan {
  rowType: "PAYROLL";
  moaumIdNumber: string;
  memberName: string;
  memberId: string;
  loanAccountNo: string | null;
  loanId: string | null;
  /** Posted to the member's Overpayment Credit instead of a loan. */
  toCredit: boolean;
  creditReason: string | null;
  amount: string;
  paymentDate: string;
  periodCovered: string | null;
  receiptNo: string | null;
  note: string | null;
  rowHash: string;
  /** Dry-run split of the payment on its loan. */
  split?: { interest: string; principal: string; credit: string; earlierChanged: number };
}

export interface LodgementPlan {
  bankAccountId: string;
  accountLabel: string;
  depositDate: string;
  reference: string;
  amount: string;
  depositor: string | null;
  note: string | null;
  uniquenessKey: string;
}

export interface AdviceMatchLine {
  moaumIdNumber: string;
  name: string;
  advice: string;
  schedule: string;
  ok: boolean;
}

/** What a dry run stores on the batch, re-checked at commit. */
interface StoredHeader {
  input: ScheduleHeaderInput;
  header: ScheduleHeader;
  checksum: string;
  lodgementsRaw: Array<{ rowNo: number; values: Record<string, string> }>;
  lodgements: Array<{ rowNo: number; data: LodgementPlan | null; errors: string[] }>;
  batchErrors: string[];
  adviceId: string | null;
  adviceMatch: AdviceMatchLine[];
  totals: { rows: string; payroll: string; credit: string; lodged: string };
}

const text = (v: string | undefined) => (v ?? "").trim();
const optional = (v: string | undefined) => text(v) || null;

function parseDate(value: string): LocalDate | null {
  try {
    return localDate(value.trim());
  } catch {
    return null;
  }
}

/** Checks the form fields; problems here are fixed on the form, before any file is read. */
export async function parseScheduleHeader(db: Db, input: ScheduleHeaderInput): Promise<ScheduleHeader> {
  const source = await activeSource(db, input.remittanceSource);
  const scheduleReference = input.scheduleReference.trim();
  if (scheduleReference.length < 2 || scheduleReference.length > 80) throw new RemittanceError("Schedule reference: enter the reference on the schedule.");
  const type = input.scheduleType.trim().toUpperCase();
  if (type !== "REGULAR" && type !== "SUPPLEMENTARY") throw new RemittanceError("Schedule type: choose REGULAR or SUPPLEMENTARY.");
  const adviceReference = input.adviceReference.trim();
  if (!adviceReference) throw new RemittanceError("Advice reference: enter the Source Advice this schedule matches.");
  const submittedBy = input.submittedBy.trim();
  if (submittedBy.length < 2) throw new RemittanceError("Submitted by: enter who sent the schedule.");
  const total = positiveAmount(input.controlTotal);
  if ("error" in total) throw new RemittanceError(`Control total ${total.error}.`);
  return {
    scheduleReference,
    remittanceSourceId: source.id,
    sourceCode: source.code,
    monthCovered: parseMonth(input.monthCovered),
    type,
    adviceReference,
    submittedBy: submittedBy.slice(0, 120),
    controlTotal: total.value.toString(),
    rowCount: parseCount(input.rowCount, "Row count"),
  };
}

type RawRow = { rowNo: number; values: Record<string, string> };

/**
 * Every F9 validation. Row problems go on the row; problems with the batch as
 * a whole (totals, references, the advice) go in batchErrors. Any problem
 * rejects the whole batch.
 */
export async function validateSchedule(db: Db, header: ScheduleHeader, rawRows: RawRow[], rawLodgements: RawRow[], today: LocalDate = todayInLagos()) {
  const batchErrors: string[] = [];
  const [usedRef, regular, advice, goLive] = await Promise.all([
    db.remittanceSchedule.findUnique({
      where: { remittanceSourceId_scheduleReference: { remittanceSourceId: header.remittanceSourceId, scheduleReference: header.scheduleReference } },
    }),
    header.type === "REGULAR"
      ? db.remittanceSchedule.findFirst({ where: { remittanceSourceId: header.remittanceSourceId, monthCovered: header.monthCovered, type: "REGULAR" } })
      : null,
    db.sourceAdvice.findUnique({
      where: { remittanceSourceId_adviceReference: { remittanceSourceId: header.remittanceSourceId, adviceReference: header.adviceReference } },
      include: { rows: true },
    }),
    getDateSetting(db, "go_live_date", today),
  ]);
  if (usedRef) batchErrors.push(`Schedule reference ${header.scheduleReference} was already posted for ${header.sourceCode}.`);
  if (regular) batchErrors.push(`${header.sourceCode} already has a REGULAR schedule for ${header.monthCovered} (${regular.scheduleReference}). Later additions go on a SUPPLEMENTARY schedule.`);
  if (!advice) batchErrors.push(`No Source Advice ${header.adviceReference} for ${header.sourceCode}. The Finance Manager uploads it first.`);
  else if (advice.status !== "AVAILABLE") batchErrors.push(`Source Advice ${header.adviceReference} has already been used by another schedule.`);
  else if (advice.monthCovered !== header.monthCovered) batchErrors.push(`Source Advice ${header.adviceReference} covers ${advice.monthCovered}, not ${header.monthCovered}.`);

  const ids = [...new Set(rawRows.map((r) => text(r.values.member_moaum_id)).filter(Boolean))];
  const members = await db.member.findMany({
    where: { moaumIdNumber: { in: ids, mode: "insensitive" } },
    select: { id: true, fullName: true, status: true, moaumIdNumber: true, memberNo: true },
  });
  const memberById = new Map(members.map((m) => [m.moaumIdNumber.toUpperCase(), m]));
  const byPayroll = await membersByPayrollKey(
    db,
    header.remittanceSourceId,
    rawRows.map((r) => normalizeStaffNo(r.values.payroll_staff_no ?? "")),
  );
  for (const m of byPayroll.values()) memberById.set(m.moaumIdNumber.toUpperCase(), m);
  const loans = await db.loan.findMany({
    where: { memberId: { in: [...memberById.values()].map((m) => m.id) }, status: { not: "DRAFT" } },
    select: { id: true, memberId: true, status: true, loanAccountNo: true, legacyAccountNo: true, d0: true },
  });
  const lastDay = localDate(monthEnd(header.monthCovered));

  const rows: PreviewRow<ScheduleRowPlan>[] = rawRows.map(({ rowNo, values }) => {
    const errors: string[] = [];
    const rowType = text(values.row_type).toUpperCase();
    if (rowType === "DIRECT") errors.push("row_type: DIRECT payment rows are accepted from release 1c, once bank credits can be tagged to members.");
    else if (rowType !== "PAYROLL") errors.push("row_type: enter PAYROLL.");
    const staffNo = normalizeStaffNo(values.payroll_staff_no ?? "");
    const fromPayroll = staffNo ? byPayroll.get(staffNo) : undefined;
    const moaumIdNumber = fromPayroll ? fromPayroll.moaumIdNumber.toUpperCase() : text(values.member_moaum_id).toUpperCase();
    const member = memberById.get(moaumIdNumber);
    if (staffNo) {
      if (!fromPayroll) errors.push(`Staff number ${staffNo} is not linked to a member on ${header.sourceCode}. Record it on the member first.`);
    } else if (!moaumIdNumber) errors.push("member_moaum_id: empty.");
    else if (!member) errors.push(`member_moaum_id: ${moaumIdNumber} is not in the register.`);
    else if (member.status !== "ACTIVE" && member.status !== "EXITED") errors.push(`member_moaum_id: ${member.fullName} is ${member.status.toLowerCase()}, not an active member.`);
    const amount = positiveAmount(values.amount_paid ?? "");
    if ("error" in amount) errors.push(`amount_paid ${amount.error}.`);
    const paymentDate = parseDate(values.payment_date ?? "");
    if (!paymentDate) errors.push("payment_date: use YYYY-MM-DD.");
    else {
      if (compareDates(paymentDate, today) > 0) errors.push(`payment_date ${paymentDate} is in the future.`);
      if (compareDates(paymentDate, lastDay) > 0) errors.push(`payment_date ${paymentDate} is after the month covered (${header.monthCovered}).`);
      if (goLive && compareDates(paymentDate, goLive) < 0) errors.push(`payment_date ${paymentDate} is before the go-live date ${goLive}.`);
    }

    // Loan resolution (PRD F9).
    const loanNo = text(values.loan_account_no).toUpperCase();
    let loanId: string | null = null;
    let toCredit = false;
    let creditReason: string | null = null;
    let loanAccountNo: string | null = loanNo || null;
    if (member) {
      const own = loans.filter((l) => l.memberId === member.id);
      let loan: (typeof loans)[number] | undefined;
      if (loanNo) {
        const any = loans.find((l) => l.loanAccountNo?.toUpperCase() === loanNo || l.legacyAccountNo?.toUpperCase() === loanNo);
        loan = own.find((l) => l.loanAccountNo?.toUpperCase() === loanNo || l.legacyAccountNo?.toUpperCase() === loanNo);
        if (!loan) errors.push(any ? `loan_account_no: ${loanNo} does not belong to this member.` : `loan_account_no: ${loanNo} does not belong to this member or does not exist.`);
        else if (loan.status === "CLOSED") {
          toCredit = true;
          creditReason = `Loan ${loanNo} is closed`;
        } else if (loan.status !== "ACTIVE") errors.push(`loan_account_no: ${loanNo} is not active (it is ${loan.status.toLowerCase().replace("_", " ")}).`);
      } else {
        const active = own.filter((l) => l.status === "ACTIVE");
        if (active.length === 0) {
          toCredit = true;
          creditReason = "No active loan";
        } else if (active.length === 1) loan = active[0];
        else errors.push(`loan_account_no required: the member has ${active.length} active loans.`);
      }
      if (loan && !toCredit) {
        loanId = loan.id;
        loanAccountNo = loan.loanAccountNo ?? loan.legacyAccountNo;
        if (paymentDate && loan.d0 && compareDates(paymentDate, fromDbDate(loan.d0)) < 0) {
          errors.push(`payment_date ${paymentDate} is before the loan was paid out (${fromDbDate(loan.d0)}).`);
        }
      }
    }

    const amountText = "value" in amount ? amount.value.toString() : "0";
    const periodCovered = optional(values.period_covered);
    const receiptNo = optional(values.receipt_no);
    const bankCreditRef = optional(values.bank_credit_ref);
    const note = optional(values.row_note);
    const data: ScheduleRowPlan = {
      rowType: "PAYROLL",
      moaumIdNumber: moaumIdNumber || staffNo,
      memberName: text(values.member_name) || member?.fullName || "",
      memberId: member?.id ?? "",
      loanAccountNo,
      loanId,
      toCredit,
      creditReason,
      amount: amountText,
      paymentDate: paymentDate ?? "",
      periodCovered,
      receiptNo,
      note,
      rowHash: rowHash({ rowType, moaumIdNumber: moaumIdNumber || staffNo, loanNo, amount: amountText, paymentDate: paymentDate ?? "", periodCovered, receiptNo, bankCreditRef }),
    };
    return { rowNo, raw: values, data, errors };
  });
  flagDuplicates(rows, (r) => r.data.rowHash, "member, loan, amount and date (a duplicate row)");

  // Totals and counts.
  const total = (list: PreviewRow<ScheduleRowPlan>[]) => list.reduce((t, r) => kobo(t + BigInt(r.data.amount)), ZERO);
  const rowsTotal = total(rows);
  if (rowsTotal !== BigInt(header.controlTotal)) batchErrors.push(`The rows total ${naira(rowsTotal)} but the control total is ${naira(BigInt(header.controlTotal))}.`);
  if (rows.length !== header.rowCount) batchErrors.push(`The file has ${rows.length} rows but the row count is ${header.rowCount}.`);
  if (rows.length === 0) batchErrors.push("The Rows sheet is empty.");

  // Payroll rows must match the Source Advice member by member.
  const adviceMatch: AdviceMatchLine[] = [];
  if (advice) {
    const scheduled = new Map<string, { name: string; amount: Kobo; rows: PreviewRow<ScheduleRowPlan>[] }>();
    for (const r of rows) {
      if (!r.data.moaumIdNumber) continue;
      const entry = scheduled.get(r.data.moaumIdNumber) ?? { name: r.data.memberName, amount: ZERO, rows: [] };
      entry.amount = kobo(entry.amount + BigInt(r.data.amount));
      entry.rows.push(r);
      scheduled.set(r.data.moaumIdNumber, entry);
    }
    const advised = new Map(advice.rows.map((a) => [a.moaumIdNumber.toUpperCase(), a]));
    for (const [id, s] of scheduled) {
      const a = advised.get(id);
      const ok = a !== undefined && a.amount === s.amount;
      adviceMatch.push({ moaumIdNumber: id, name: s.name, advice: a ? a.amount.toString() : "", schedule: s.amount.toString(), ok });
      if (!a) for (const r of s.rows) r.errors.push(`Not on Source Advice ${advice.adviceReference}.`);
      else if (!ok) for (const r of s.rows) r.errors.push(`Advice says ${naira(a.amount)} for this member; the schedule's rows total ${naira(s.amount)}.`);
    }
    for (const [id, a] of advised) {
      if (scheduled.has(id)) continue;
      adviceMatch.push({ moaumIdNumber: id, name: a.memberName, advice: a.amount.toString(), schedule: "", ok: false });
      batchErrors.push(`${a.memberName} (${id}) is on the Source Advice for ${naira(a.amount)} but not on the schedule.`);
    }
  }

  // Lodgements.
  const accounts = await db.bankAccount.findMany();
  const byNumber = new Map(accounts.map((a) => [a.accountNumber.replace(/\s/g, ""), a]));
  const lodgements = rawLodgements.map(({ rowNo, values }) => {
    const errors: string[] = [];
    const account = byNumber.get(text(values.bank_account).replace(/\s/g, ""));
    if (!account) errors.push(`bank_account: ${text(values.bank_account) || "empty"} is not a MOAUM account set up by Admin.`);
    else if (!account.active) errors.push(`bank_account: ${account.accountNumber} is switched off.`);
    const depositDate = parseDate(values.deposit_date ?? "");
    if (!depositDate) errors.push("deposit_date: use YYYY-MM-DD.");
    else if (compareDates(depositDate, today) > 0) errors.push(`deposit_date ${depositDate} is in the future.`);
    const reference = text(values.reference);
    if (!reference) errors.push("reference: enter the slip number or transfer reference.");
    const amount = positiveAmount(values.amount ?? "");
    if ("error" in amount) errors.push(`amount ${amount.error}.`);
    const value = "value" in amount ? amount.value.toString() : "0";
    const data: LodgementPlan | null =
      errors.length === 0 && account && depositDate
        ? {
            bankAccountId: account.id,
            accountLabel: `${account.bankName} ${account.accountNumber}`,
            depositDate,
            reference,
            amount: value,
            depositor: optional(values.depositor),
            note: optional(values.note),
            uniquenessKey: `${account.accountNumber}|${reference.toUpperCase()}|${value}|${depositDate}`,
          }
        : null;
    return { rowNo, data, errors };
  });
  const lodgementSeen = new Map<string, number>();
  for (const l of lodgements) {
    if (!l.data) continue;
    const first = lodgementSeen.get(l.data.uniquenessKey);
    if (first !== undefined) l.errors.push(`Same lodgement as row ${first}.`);
    else lodgementSeen.set(l.data.uniquenessKey, l.rowNo);
  }
  const keys = lodgements.flatMap((l) => (l.data ? [l.data.uniquenessKey] : []));
  const usedKeys = keys.length ? await db.lodgement.findMany({ where: { uniquenessKey: { in: keys } }, select: { uniquenessKey: true } }) : [];
  const used = new Set(usedKeys.map((u) => u.uniquenessKey));
  for (const l of lodgements) if (l.data && used.has(l.data.uniquenessKey)) l.errors.push("This lodgement was already declared on an earlier schedule.");

  const credit = total(rows.filter((r) => r.data.toCredit));
  const lodged = lodgements.reduce((t, l) => kobo(t + BigInt(l.data?.amount ?? "0")), ZERO);
  return {
    rows,
    lodgements,
    batchErrors,
    adviceId: advice?.id ?? null,
    adviceMatch,
    totals: { rows: rowsTotal.toString(), payroll: rowsTotal.toString(), credit: credit.toString(), lodged: lodged.toString() },
  };
}

/** Dry-run split of each new payment on its loan (what posting will do). */
async function previewSplits(db: Db, rows: PreviewRow<ScheduleRowPlan>[], today: LocalDate): Promise<void> {
  const byLoan = new Map<string, PreviewRow<ScheduleRowPlan>[]>();
  for (const r of rows) if (r.data.loanId && !r.data.toCredit) byLoan.set(r.data.loanId, [...(byLoan.get(r.data.loanId) ?? []), r]);
  for (const [loanId, list] of byLoan) {
    const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } });
    const extra = list.map((r) => ({
      id: `row-${r.rowNo}`,
      date: localDate(r.data.paymentDate),
      amount: kobo(BigInt(r.data.amount)),
      order: `9999|${String(r.rowNo).padStart(6, "0")}`,
    }));
    try {
      const plan = await planRecompute(db, loan, today, extra);
      for (const r of list) {
        const mine = plan.toPost.filter((a) => a.paymentId === `row-${r.rowNo}`);
        const sum = (kind: string) => mine.filter((a) => a.kind === kind).reduce((t, a) => t + a.amount, 0n).toString();
        r.data.split = { interest: sum("INTEREST"), principal: sum("PRINCIPAL"), credit: sum("OVERPAYMENT"), earlierChanged: plan.toReverse.length };
      }
    } catch (error) {
      for (const r of list) r.errors.push(error instanceof Error ? error.message : "The payment could not be allocated.");
    }
  }
}

/**
 * The schedule's rows and lodgement lines: from the payroll voucher exactly as
 * it arrives (members by staff number, one payment date from the form), or
 * from the template's Rows and Lodgements sheets.
 */
async function readScheduleFile(header: ScheduleHeader, input: ScheduleHeaderInput, file: UploadedFile): Promise<{ rows: RawRow[]; lodgements: RawRow[] }> {
  const voucher = await readPayrollVoucher(file.filename, file.bytes);
  if (voucher) {
    if (voucher.month && voucher.month !== header.monthCovered) {
      throw new RemittanceError(`The file is for ${voucher.month} ("${voucher.title}") but the month covered is ${header.monthCovered}.`);
    }
    const paymentDate = (input.paymentDate ?? "").trim();
    if (!paymentDate) throw new RemittanceError("Payment date: a payroll voucher has no dates. Enter the day salaries were paid.");
    return {
      rows: voucher.rows.map((r) => ({
        rowNo: r.rowNo,
        values: { row_type: "PAYROLL", payroll_staff_no: r.staffNo, member_name: r.name, amount_paid: r.amount, payment_date: paymentDate },
      })),
      lodgements: [],
    };
  }
  const csv = file.filename.toLowerCase().endsWith(".csv");
  const rowsTable = await readTable(file.filename, file.bytes, { sheet: csv ? undefined : "Rows" });
  assertColumns(rowsTable, SCHEDULE_ROW_COLUMNS.filter((c) => c.required).map((c) => c.name));
  const lodgementTable = csv ? { headers: [], rows: [] } : await readTable(file.filename, file.bytes, { sheet: "Lodgements", optional: true });
  if (lodgementTable.rows.length > 0) assertColumns(lodgementTable, LODGEMENT_COLUMNS.filter((c) => c.required).map((c) => c.name));
  return { rows: rowsTable.rows, lodgements: lodgementTable.rows };
}

const hasErrors = (v: Awaited<ReturnType<typeof validateSchedule>>) =>
  v.batchErrors.length > 0 || v.rows.some((r) => r.errors.length > 0) || v.lodgements.some((l) => l.errors.length > 0);

/**
 * Treasurer's dry run (PRD F9): checks the header and both sheets, stores the
 * file as evidence and the per-row log, and shows what posting would do.
 */
export async function previewSchedule(db: Db, store: EvidenceStore, actor: RemittanceActor, input: ScheduleHeaderInput, file: UploadedFile) {
  const header = await parseScheduleHeader(db, input);
  const { rows: rawRows, lodgements: rawLodgements } = await readScheduleFile(header, input, file);

  const today = todayInLagos();
  const checked = await validateSchedule(db, header, rawRows, rawLodgements, today);
  if (!hasErrors(checked)) await previewSplits(db, checked.rows, today);
  const evidence = await storeEvidenceBytes(db, store, actor, file.filename, file.bytes);
  const stored: StoredHeader = {
    input,
    header,
    checksum: evidence.sha256,
    lodgementsRaw: rawLodgements,
    lodgements: checked.lodgements,
    batchErrors: checked.batchErrors,
    adviceId: checked.adviceId,
    adviceMatch: checked.adviceMatch,
    totals: checked.totals,
  };
  const batch = await saveBatch(db, {
    kind: "REMITTANCE_SCHEDULE",
    filename: file.filename,
    evidenceId: evidence.evidenceId,
    uploadedById: actor.id,
    rows: checked.rows,
    header: stored as unknown as Prisma.InputJsonValue,
    batchErrorCount: checked.batchErrors.length + checked.lodgements.filter((l) => l.errors.length > 0).length,
  });
  return { batchId: batch.id, ok: !hasErrors(checked) };
}

/** A stored dry run for the preview page. */
export async function loadSchedulePreview(db: Db, batchId: string) {
  const batch = await db.importBatch.findUnique({ where: { id: batchId }, include: { rows: { orderBy: { rowNo: "asc" } } } });
  if (!batch || batch.kind !== "REMITTANCE_SCHEDULE" || !batch.header) return null;
  const stored = batch.header as unknown as StoredHeader;
  return {
    batch,
    stored,
    rows: batch.rows.map((r) => {
      const d = r.data as { raw: Record<string, string>; parsed: ScheduleRowPlan | null };
      return { rowNo: r.rowNo, raw: d.raw, plan: d.parsed, errors: r.errors };
    }),
  };
}

export interface CommitHooks {
  /** Tests only: runs inside the transaction after the loans are posted. */
  beforeFinish?: (tx: Db) => Promise<void>;
}

/**
 * Commits a previewed schedule (PRD F9): re-runs every validation, then posts
 * the schedule, its rows and lodgements, the ledger events and each loan's
 * recompute in one transaction. No second-human approval.
 */
export async function commitSchedule(db: PrismaClient, actor: RemittanceActor, batchId: string, hooks: CommitHooks = {}) {
  const batch = await loadPreviewedBatch(db, batchId, "REMITTANCE_SCHEDULE", actor.id);
  if (!batch || !batch.header || !batch.evidenceId) throw new RemittanceError("This schedule was already committed or has expired. Upload it again.");
  const stored = batch.header as unknown as StoredHeader;
  const evidenceId = batch.evidenceId;
  const today = todayInLagos();
  const header = await parseScheduleHeader(db, stored.input);
  const checked = await validateSchedule(
    db,
    header,
    batch.rows.map((r) => ({ rowNo: r.rowNo, values: (r.data as { raw: Record<string, string> }).raw })),
    stored.lodgementsRaw,
    today,
  );
  if (hasErrors(checked)) {
    const errorRows = checked.rows.filter((r) => r.errors.length > 0);
    await db.$transaction([
      ...errorRows.map((r) => db.importRowLog.update({ where: { batchId_rowNo: { batchId: batch.id, rowNo: r.rowNo } }, data: { errors: r.errors } })),
      db.importBatch.update({
        where: { id: batch.id },
        data: {
          status: "REJECTED",
          errorRowCount: errorRows.length,
          header: { ...stored, batchErrors: checked.batchErrors, lodgements: checked.lodgements } as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);
    throw new RemittanceError("Nothing was posted: the schedule no longer passes every check.", [
      ...checked.batchErrors,
      ...errorRows.map((r) => `Row ${r.rowNo}: ${r.errors.join(" ")}`),
      ...checked.lodgements.filter((l) => l.errors.length).map((l) => `Lodgement row ${l.rowNo}: ${l.errors.join(" ")}`),
    ]);
  }

  const now = new Date();
  const scheduleId = randomUUID();
  const rows = checked.rows.map((r) => ({ id: randomUUID(), rowNo: r.rowNo, plan: r.data }));
  const lodgements = checked.lodgements.flatMap((l) => (l.data ? [l.data] : []));
  const adviceId = checked.adviceId as string;
  const trigger = `SCHEDULE:${scheduleId}`;
  const reason = `Schedule ${header.scheduleReference} (${header.sourceCode} ${header.monthCovered})`;

  await db.$transaction(async (tx) => {
    const { count } = await tx.sourceAdvice.updateMany({ where: { id: adviceId, status: "AVAILABLE" }, data: { status: "USED" } });
    if (count !== 1) throw new RemittanceError("The Source Advice was used by another schedule just now.");
    await tx.remittanceSchedule.create({
      data: {
        id: scheduleId,
        remittanceSourceId: header.remittanceSourceId,
        scheduleReference: header.scheduleReference,
        monthCovered: header.monthCovered,
        type: header.type,
        adviceId,
        submittedBy: header.submittedBy,
        controlTotal: BigInt(header.controlTotal),
        rowCount: header.rowCount,
        evidenceId,
        checksum: stored.checksum,
        uploadedById: actor.id,
        postedAt: now,
      },
    });
    await tx.remittanceRow.createMany({
      data: rows.map(({ id, rowNo, plan }) => ({
        id,
        scheduleId,
        rowNo,
        rowType: plan.rowType,
        memberId: plan.memberId,
        loanId: plan.loanId,
        toCredit: plan.toCredit,
        amount: BigInt(plan.amount),
        paymentDate: new Date(`${plan.paymentDate}T00:00:00Z`),
        periodCovered: plan.periodCovered,
        receiptNo: plan.receiptNo,
        note: plan.note,
        rowHash: plan.rowHash,
      })),
    });
    if (lodgements.length) {
      await tx.lodgement.createMany({
        data: lodgements.map((l) => ({
          scheduleId,
          bankAccountId: l.bankAccountId,
          depositDate: new Date(`${l.depositDate}T00:00:00Z`),
          reference: l.reference,
          amount: BigInt(l.amount),
          depositor: l.depositor,
          note: l.note,
          uniquenessKey: l.uniquenessKey,
        })),
      });
    }

    const statusEvent = (eventType: "SCHEDULE_ACCEPTED" | "SCHEDULE_POSTED") =>
      postEvent(tx, {
        occurredAt: now,
        moduleCode: "CREDIT",
        eventType,
        source: "REMITTANCE_SCHEDULE",
        evidenceRefs: [evidenceId],
        portalUserId: actor.id,
        moduleEntityType: "RemittanceSchedule",
        moduleEntityId: scheduleId,
        uniquenessKey: `CREDIT:${eventType}:${scheduleId}`,
        metadata: {
          amount: header.controlTotal,
          rowCount: header.rowCount,
          scheduleReference: header.scheduleReference,
          source: header.sourceCode,
          monthCovered: header.monthCovered,
        },
      });
    await statusEvent("SCHEDULE_ACCEPTED");

    // Rows that go straight to Overpayment Credit.
    for (const { id, plan } of rows.filter((r) => r.plan.toCredit)) {
      await postEvent(tx, {
        occurredAt: new Date(`${plan.paymentDate}T00:00:00Z`),
        moduleCode: "CREDIT",
        eventType: "DEPOSIT_CREDITED",
        source: "REMITTANCE_SCHEDULE",
        evidenceRefs: [evidenceId],
        portalUserId: actor.id,
        moduleEntityType: "Member",
        moduleEntityId: plan.memberId,
        depositDelta: BigInt(plan.amount),
        uniquenessKey: `CREDIT:ROW:${id}:CREDIT`,
        metadata: { rowId: id, scheduleId, reason: plan.creditReason, loanAccountNo: plan.loanAccountNo },
      });
    }

    // Each affected loan is recomputed from all its payments (PRD F6).
    const loanIds = [...new Set(rows.flatMap((r) => (r.plan.loanId && !r.plan.toCredit ? [r.plan.loanId] : [])))];
    for (const loanId of loanIds) {
      const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
      const plan = await planRecompute(tx, loan, today);
      await applyRecompute(tx, loan, plan, { actor, trigger, evidenceId, reason, now });
    }
    await hooks.beforeFinish?.(tx);

    await statusEvent("SCHEDULE_POSTED");
    await linkEvidence(tx, actor, {
      evidenceId,
      entityType: "RemittanceSchedule",
      entityId: scheduleId,
      kind: "PRIMARY",
      submissionKey: `REMITTANCE_SCHEDULE:${scheduleId}`,
    });
    await tx.importBatch.update({ where: { id: batch.id }, data: { status: "COMMITTED", committedById: actor.id, committedAt: now, errorRowCount: 0 } });
    await writeAudit(tx, {
      action: "schedule.commit",
      entityType: "RemittanceSchedule",
      entityId: scheduleId,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: evidenceId,
      after: {
        scheduleReference: header.scheduleReference,
        source: header.sourceCode,
        monthCovered: header.monthCovered,
        type: header.type,
        rows: rows.length,
        controlTotal: header.controlTotal,
        checksum: stored.checksum,
        lodgements: lodgements.length,
        loans: loanIds.length,
      },
    });
  }, REMITTANCE_TX);

  return { scheduleId, rows: rows.length, credited: rows.filter((r) => r.plan.toCredit).length };
}

/** Posted schedules, newest first. */
export async function listSchedules(db: Db, take = 50) {
  return db.remittanceSchedule.findMany({
    orderBy: { postedAt: "desc" },
    take,
    include: { remittanceSource: { select: { code: true } }, _count: { select: { rows: true, lodgements: true } } },
  });
}
