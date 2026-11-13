import ExcelJS from "exceljs";
import type { Db } from "@/lib/db";
import { compareDates, todayInLagos, type LocalDate } from "@/lib/dates";
import { applyRate, bps, kobo } from "@/lib/money";
import { loanLiveState } from "../loans/repayments";
import { reportPdf, type ReportResult } from "./staff-reports";

/**
 * The deduction schedule MOAUM sends to a payroll office (the bursary): what to
 * deduct from each member's salary, month by month, until their loans are
 * cleared. The file has exactly the bursary's six columns:
 *
 *   SN | NAME | PNO | AMOUNT | STARTDATE | ENDDATE      (dates as YYYYMM)
 *
 * Loans run on a reducing balance, so the amount differs every month: each
 * member gets one row per month, with that month as both start and end date.
 * A member with several loans gets one combined amount per month.
 *
 * No pay day is assumed. A month is finished for a payroll once its remittance
 * has been posted; the next instalment of every loan is then deducted in the
 * first month not yet remitted, and the ones after it in the months that follow.
 */
export class DeductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeductionError";
  }
}

export interface DeductionRow {
  memberId: string;
  name: string;
  staffNo: string;
  /** YYYY-MM. */
  month: string;
  amount: bigint;
}

export interface DeductionMember {
  memberId: string;
  name: string;
  staffNo: string;
  memberNo: string;
  loans: string[];
  /** Deduction for the schedule's first month, arrears included. */
  thisMonth: bigint;
  /** Of which is overdue from earlier months. */
  arrears: bigint;
  /** Everything still to deduct, as projected today. */
  total: bigint;
  lastMonth: string;
  /** No repayment has been posted for any of the member's loans yet. */
  isNew: boolean;
  /** The first month's deduction clears everything. */
  isFinal: boolean;
}

export interface DeductionSchedule {
  source: { id: string; code: string; name: string };
  month: string;
  asOf: LocalDate;
  /** The latest month a posted remittance covers for this payroll, if any. */
  lastRemitted: string | null;
  rows: DeductionRow[];
  members: DeductionMember[];
  /** Members whose loans were cleared recently: the bursary stops deducting from them. */
  stopped: Array<{ name: string; staffNo: string; loan: string; closedOn: string }>;
  /** Members with a loan but no staff number: they can't be put on a payroll file. */
  missingStaffNo: string[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};

/** The latest month covered by a posted remittance schedule of this payroll: that month is finished. */
export async function lastRemittedMonth(db: Db, sourceId: string): Promise<string | null> {
  const last = await db.remittanceSchedule.findFirst({ where: { remittanceSourceId: sourceId }, orderBy: { monthCovered: "desc" }, select: { monthCovered: true } });
  return last?.monthCovered ?? null;
}

/** The first month deductions can still be made in: the month after the last remitted one, or the current month. */
export async function nextDeductionMonth(db: Db, sourceId: string, today: LocalDate = todayInLagos()): Promise<string> {
  const last = await lastRemittedMonth(db, sourceId);
  return last ? addMonths(last, 1) : today.slice(0, 7);
}

/**
 * Builds the schedule for one payroll source, starting at `month`, from every
 * ACTIVE loan as it stands today. Each loan's next instalment, with anything
 * already overdue, goes in `month`; the instalments after it go in the months
 * that follow, one a month. Later months assume each deduction is made as
 * listed; the schedule is produced again each month, so a missed or extra
 * payment is picked up then.
 */
export async function deductionSchedule(db: Db, sourceId: string, month: string, today: LocalDate = todayInLagos()): Promise<DeductionSchedule> {
  if (!MONTH.test(month)) throw new DeductionError("Enter the first month as YYYY-MM.");
  const source = await db.remittanceSource.findUnique({ where: { id: sourceId } });
  if (!source) throw new DeductionError("Choose the payroll source.");
  const lastRemitted = await lastRemittedMonth(db, sourceId);
  if (lastRemitted && month <= lastRemitted) {
    throw new DeductionError(`The remittance for ${lastRemitted} has been posted for ${source.code}, so that month is finished. Deductions start from ${addMonths(lastRemitted, 1)}.`);
  }

  const loans = await db.loan.findMany({
    where: { status: "ACTIVE", d0: { not: null }, member: { remittanceSourceId: sourceId } },
    include: { member: { select: { id: true, fullName: true, memberNo: true, payrollStaffNo: true } } },
    orderBy: { createdAt: "asc" },
  });

  const perMember = new Map<string, { member: (typeof loans)[number]["member"]; loans: string[]; byMonth: Map<string, bigint>; arrears: bigint; paid: boolean }>();
  for (const loan of loans) {
    const live = await loanLiveState(db, loan, today);
    if (!live || live.state.status !== "ACTIVE") continue;
    const entry = perMember.get(loan.member.id) ?? { member: loan.member, loans: [], byMonth: new Map<string, bigint>(), arrears: 0n, paid: false };
    perMember.set(loan.member.id, entry);
    entry.loans.push(loan.loanAccountNo ?? loan.legacyAccountNo ?? "");
    if (live.repayments.length > 0) entry.paid = true;
    const put = (slot: number, amount: bigint) => {
      if (amount <= 0n) return;
      const at = addMonths(month, slot);
      entry.byMonth.set(at, (entry.byMonth.get(at) ?? 0n) + amount);
    };

    // Cycles already reached: whatever of them is unpaid is the next deduction (overdue amounts included).
    let next = 0n;
    for (const i of live.state.installments) {
      const unpaid = i.principal - i.principalPaid + (i.interest - i.interestPaid);
      if (unpaid <= 0n) continue;
      next += unpaid;
      if (compareDates(i.dueDate, today) < 0) entry.arrears += unpaid;
    }
    put(0, next);
    // Cycles still to come, one a month after that: scheduled principal plus interest on the balance then outstanding.
    const rate = bps(BigInt(loan.rateBps ?? 0));
    let balance = live.state.futurePrincipal.reduce((t, f) => t + f.principal, 0n);
    let slot = next > 0n ? 1 : 0;
    for (const f of live.state.futurePrincipal) {
      put(slot++, f.principal + applyRate(kobo(balance), rate));
      balance -= f.principal;
    }
  }

  const rows: DeductionRow[] = [];
  const members: DeductionMember[] = [];
  const missingStaffNo: string[] = [];
  const sorted = [...perMember.values()].sort((a, b) => a.member.fullName.localeCompare(b.member.fullName));
  for (const e of sorted) {
    if (e.byMonth.size === 0) continue;
    if (!e.member.payrollStaffNo) {
      missingStaffNo.push(e.member.fullName);
      continue;
    }
    const months = [...e.byMonth.keys()].sort();
    for (const m of months) rows.push({ memberId: e.member.id, name: e.member.fullName.toUpperCase(), staffNo: e.member.payrollStaffNo, month: m, amount: e.byMonth.get(m) as bigint });
    members.push({
      memberId: e.member.id,
      name: e.member.fullName,
      staffNo: e.member.payrollStaffNo,
      memberNo: e.member.memberNo,
      loans: e.loans,
      thisMonth: e.byMonth.get(month) ?? 0n,
      arrears: e.arrears,
      total: [...e.byMonth.values()].reduce((t, v) => t + v, 0n),
      lastMonth: months.at(-1) as string,
      isNew: !e.paid,
      isFinal: months.length === 1 && months[0] === month,
    });
  }
  // Month by month, then by name: the order a payroll office works through.
  rows.sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));

  const since = new Date(new Date(`${today}T00:00:00Z`).getTime() - 62 * 86_400_000);
  const closed = await db.loan.findMany({
    where: { status: "CLOSED", closedOn: { gte: since }, member: { remittanceSourceId: sourceId } },
    include: { member: { select: { id: true, fullName: true, payrollStaffNo: true } } },
    orderBy: { closedOn: "desc" },
  });
  const stopped = closed
    .filter((l) => !perMember.has(l.member.id))
    .map((l) => ({ name: l.member.fullName, staffNo: l.member.payrollStaffNo ?? "", loan: l.loanAccountNo ?? l.legacyAccountNo ?? "", closedOn: l.closedOn?.toISOString().slice(0, 10) ?? "" }));

  return { source: { id: source.id, code: source.code, name: source.name }, month, asOf: today, lastRemitted, rows, members, stopped, missingStaffNo };
}

/** Keeps the file to the first month only, or gives every remaining month. */
export function scheduleRows(schedule: DeductionSchedule, scope: "all" | "month"): DeductionRow[] {
  return scope === "month" ? schedule.rows.filter((r) => r.month === schedule.month) : schedule.rows;
}

const yyyymm = (month: string) => Number(month.replace("-", ""));

/** The Excel file, exactly in the bursary's layout: one sheet, six columns, nothing else. */
export async function deductionXlsx(rows: DeductionRow[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.columns = [{ width: 6 }, { width: 32 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 12 }];
  ws.addRow(["SN", "NAME", "PNO", "AMOUNT", "STARTDATE", "ENDDATE"]);
  rows.forEach((r, i) => {
    // Kobo to naira for the spreadsheet cell: whole kobo, so two decimals are exact.
    const row = ws.addRow([i + 1, r.name, r.staffNo, Number(r.amount / 100n) + Number(r.amount % 100n) / 100, yyyymm(r.month), yyyymm(r.month)]);
    row.getCell(4).numFmt = "#,##0.00";
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** The same rows as a PDF, for printing or signing. */
export async function deductionPdf(schedule: DeductionSchedule, rows: DeductionRow[]): Promise<Uint8Array> {
  const report: ReportResult = {
    title: "Deduction schedule",
    subtitle: `${schedule.source.name} (${schedule.source.code}) · from ${schedule.month} · prepared ${schedule.asOf}`,
    columns: [
      { header: "SN", kind: "text", width: 0.5 },
      { header: "NAME", kind: "text", width: 2.6 },
      { header: "PNO", kind: "text", width: 1.1 },
      { header: "AMOUNT", kind: "money", width: 1.4 },
      { header: "STARTDATE", kind: "text", width: 1 },
      { header: "ENDDATE", kind: "text", width: 1 },
    ],
    rows: rows.map((r, i) => [String(i + 1), r.name, r.staffNo, r.amount, String(yyyymm(r.month)), String(yyyymm(r.month))]),
    totals: ["", "Total", "", rows.reduce((t, r) => t + r.amount, 0n), "", ""],
    notes: ["Amounts fall each month because interest is charged on the reducing balance.", "A new schedule each month replaces this one."],
  };
  return reportPdf(report);
}
