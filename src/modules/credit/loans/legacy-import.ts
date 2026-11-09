import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { localDate, todayInLagos, compareDates, type LocalDate } from "@/lib/dates";
import { bps, formatNaira, kobo, type Kobo } from "@/lib/money";
import { storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { getDateSetting, getRateSetting } from "@/shell/settings/settings";
import { flagDuplicates, saveBatch, type PreviewRow } from "../imports/batches";
import { readTable, TableError } from "../imports/table";
import { MAX_TENURE, planSchedule } from "../domain/schedule";
import { normalizeStaffNo } from "../remittance/payroll-voucher";
import { LoanError, nextLoanNumber, toDbDate } from "./common";

/**
 * Legacy loan import (PRD F8), adapted to the records MOAUM keeps: per loan,
 * the member's PIN (payroll staff number), what is still owed at go-live and
 * the months left. There is no history to replay, so each loan starts at
 * go-live from its outstanding principal and runs under F6 from there; one
 * OPENING_BALANCE per loan, no historic events.
 *
 * Columns (any case): name, pin, tenure (months left), principal (still owed);
 * optional sn, department, rate_monthly_percent (blank = the interest rate
 * setting at go-live; 0 = no further interest), legacy_account_no.
 */
export const LEGACY_TX = { maxWait: 15_000, timeout: 300_000 } as const;

export interface LegacyHeaderInput {
  goLiveDate: string;
  controlTotal: string;
  rowCount: string;
}

export interface LegacyActor {
  id: string;
  ipAddress: string | null;
}

export interface LegacyRowPlan {
  name: string;
  pin: string;
  memberId: string;
  memberName: string;
  memberNo: string;
  /** Kobo, as a string. */
  outstanding: string;
  tenure: number;
  rateBps: number;
  legacyAccountNo: string | null;
  firstInstallment: string;
  firstDueDate: string;
  totalInterest: string;
  warnings: string[];
}

interface StoredLegacyHeader {
  input: LegacyHeaderInput;
  goLiveDate: string;
  controlTotal: string;
  rowCount: number;
  batchErrors: string[];
  total: string;
}

const pick = (values: Record<string, string>, ...names: string[]) => {
  for (const n of names) if (values[n] !== undefined && values[n].trim() !== "") return values[n].trim();
  return "";
};

/**
 * A naira amount as it comes out of a spreadsheet ("166666.6666666667",
 * "150,000", "₦60,000.00"), rounded half up to the kobo with integer
 * arithmetic only. Returns whether rounding happened.
 */
export function parseSpreadsheetNaira(value: string): { kobo: Kobo; rounded: boolean } | null {
  const t = value.replace(/[₦,\s]/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = m[2] ?? "";
  const cents = BigInt((frac + "00").slice(0, 2));
  const roundUp = frac.length > 2 && parseInt(frac[2]!, 10) >= 5;
  return { kobo: kobo(whole * 100n + cents + (roundUp ? 1n : 0n)), rounded: frac.length > 2 && /[1-9]/.test(frac.slice(2)) };
}

/** "7.5" (percent per month) → 750 basis points; at most two decimals. */
export function parsePercentBps(value: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.replace(/[%\s]/g, ""));
  if (!m) return null;
  const n = parseInt(m[1]!, 10) * 100 + parseInt((m[2] ?? "").padEnd(2, "0"), 10);
  return n <= 10_000 ? n : null;
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

function parseHeader(input: LegacyHeaderInput) {
  let goLive: LocalDate;
  try {
    goLive = localDate(input.goLiveDate.trim());
  } catch {
    throw new LoanError("Go-live date: enter it as YYYY-MM-DD.");
  }
  const total = parseSpreadsheetNaira(input.controlTotal);
  if (!total || total.kobo <= 0n) throw new LoanError("Control total: enter the total still owed across the file, in naira.");
  const rowCount = Number(input.rowCount.trim());
  if (!Number.isInteger(rowCount) || rowCount < 1) throw new LoanError("Row count: enter the number of loans in the file.");
  return { goLive, controlTotal: total.kobo, rowCount };
}

type RawRow = { rowNo: number; values: Record<string, string> };

/** Every check on the file; row problems go on the row, file problems in batchErrors. */
export async function validateLegacyRows(db: Db, header: ReturnType<typeof parseHeader>, rawRows: RawRow[]) {
  const batchErrors: string[] = [];
  const defaultRate = await getRateSetting(db, "interest_rate_bps", header.goLive);
  const pins = [...new Set(rawRows.map((r) => normalizeStaffNo(pick(r.values, "pin", "staff_no", "payroll_staff_no"))).filter(Boolean))];
  const members = await db.member.findMany({
    where: { OR: [{ payrollStaffNo: { in: pins } }, { memberNo: { in: pins } }] },
    select: { id: true, fullName: true, memberNo: true, payrollStaffNo: true, status: true },
  });
  const legacyNos = rawRows.map((r) => pick(r.values, "legacy_account_no", "legacy_no", "loan_no").toUpperCase()).filter(Boolean);
  const takenNos = new Set(
    legacyNos.length ? (await db.loan.findMany({ where: { legacyAccountNo: { in: legacyNos } }, select: { legacyAccountNo: true } })).map((l) => l.legacyAccountNo) : [],
  );

  const rows: PreviewRow<LegacyRowPlan>[] = rawRows.map(({ rowNo, values }) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const name = pick(values, "name", "full_name", "member_name");
    const pin = normalizeStaffNo(pick(values, "pin", "staff_no", "payroll_staff_no"));
    if (!pin) errors.push("PIN: empty.");
    const matches = members.filter((m) => m.payrollStaffNo === pin || m.memberNo === pin);
    const member = matches.length === 1 ? matches[0] : undefined;
    if (pin && matches.length === 0) errors.push(`PIN ${pin}: no member has this payroll staff number. Import or register the member first, with this PIN as their staff number.`);
    if (matches.length > 1) errors.push(`PIN ${pin}: more than one member has it (on different payroll sources).`);
    if (member && member.status !== "ACTIVE") errors.push(`PIN ${pin}: ${member.fullName} is ${member.status.toLowerCase()}, not active.`);
    if (member && name && loose(name) !== loose(member.fullName)) warnings.push(`Name in the file ("${name}") differs from the member record ("${member.fullName}"). Check it is the same person.`);

    const principal = parseSpreadsheetNaira(pick(values, "principal", "outstanding", "outstanding_principal"));
    if (!principal || principal.kobo <= 0n) errors.push("Principal: enter what is still owed, more than ₦0.");
    else if (principal.rounded) warnings.push(`Principal rounded to the kobo: ${formatNaira(principal.kobo)}.`);
    const tenureText = pick(values, "tenure", "tenure_months", "months_left");
    const tenure = Number(tenureText);
    if (!Number.isInteger(tenure) || tenure < 1 || tenure > MAX_TENURE) errors.push(`Tenure: whole months left to pay, 1 to ${MAX_TENURE}.`);
    const rateText = pick(values, "rate_monthly_percent", "rate", "interest_rate");
    const rateBps = rateText === "" ? Number(defaultRate) : parsePercentBps(rateText);
    if (rateBps === null) errors.push(`Rate: "${rateText}" is not a monthly percentage (e.g. 7.5, or 0).`);
    const legacyAccountNo = pick(values, "legacy_account_no", "legacy_no", "loan_no").toUpperCase() || null;
    if (legacyAccountNo && takenNos.has(legacyAccountNo)) errors.push(`Legacy loan number ${legacyAccountNo} was already imported.`);

    let plan = { firstInstallment: "0", firstDueDate: "", totalInterest: "0" };
    if (errors.length === 0 && principal && rateBps !== null) {
      const s = planSchedule({ principal: principal.kobo, tenure, rate: bps(BigInt(rateBps)), d0: header.goLive });
      plan = { firstInstallment: s.installments[0]!.amount.toString(), firstDueDate: s.installments[0]!.dueDate, totalInterest: s.totalInterest.toString() };
    }
    return {
      rowNo,
      raw: values,
      errors,
      data: {
        name,
        pin,
        memberId: member?.id ?? "",
        memberName: member?.fullName ?? "",
        memberNo: member?.memberNo ?? "",
        outstanding: principal ? principal.kobo.toString() : "0",
        tenure,
        rateBps: rateBps ?? 0,
        legacyAccountNo,
        ...plan,
        warnings,
      },
    };
  });
  flagDuplicates(rows, (r) => r.data.legacyAccountNo, "legacy loan number");
  for (const [pin, list] of Object.entries(Object.groupBy(rows, (r) => r.data.pin))) {
    if (pin && (list?.length ?? 0) > 1) for (const r of list ?? []) r.data.warnings.push(`PIN ${pin} has ${list!.length} loans in this file.`);
  }

  const total = rows.reduce((t, r) => t + BigInt(r.data.outstanding), 0n);
  if (total !== header.controlTotal) batchErrors.push(`The loans total ${formatNaira(kobo(total))} still owed, but the control total is ${formatNaira(header.controlTotal)}.`);
  if (rows.length !== header.rowCount) batchErrors.push(`The file has ${rows.length} loans but the row count is ${header.rowCount}.`);
  if (rows.length === 0) batchErrors.push("The file has no loans.");
  return { rows, batchErrors, total };
}

const hasErrors = (v: { rows: PreviewRow<LegacyRowPlan>[]; batchErrors: string[] }) => v.batchErrors.length > 0 || v.rows.some((r) => r.errors.length > 0);

/** Admin's dry run: checks every row, stores the file as evidence and the per-row log. Nothing is created. */
export async function previewLegacyImport(db: Db, store: EvidenceStore, actor: LegacyActor, input: LegacyHeaderInput, file: { filename: string; bytes: Uint8Array }) {
  const header = parseHeader(input);
  const table = await readTable(file.filename, file.bytes, { isHeader: (cells) => cells.includes("pin") || cells.includes("payroll_staff_no") });
  for (const col of ["pin", "tenure", "principal"]) {
    const aliases = { pin: ["pin", "staff_no", "payroll_staff_no"], tenure: ["tenure", "tenure_months", "months_left"], principal: ["principal", "outstanding", "outstanding_principal"] }[col]!;
    if (!aliases.some((a) => table.headers.includes(a))) throw new TableError(`Missing column: ${col}. The file needs at least Name, PIN, Tenure and Principal.`);
  }
  const checked = await validateLegacyRows(db, header, table.rows);
  const evidence = await storeEvidenceBytes(db, store, actor, file.filename, file.bytes);
  const stored: StoredLegacyHeader = {
    input,
    goLiveDate: header.goLive,
    controlTotal: header.controlTotal.toString(),
    rowCount: header.rowCount,
    batchErrors: checked.batchErrors,
    total: checked.total.toString(),
  };
  const batch = await saveBatch(db, {
    kind: "LEGACY_LOANS",
    filename: file.filename,
    evidenceId: evidence.evidenceId,
    uploadedById: actor.id,
    rows: checked.rows,
    header: stored as unknown as Prisma.InputJsonValue,
    batchErrorCount: checked.batchErrors.length,
  });
  return { batchId: batch.id, ok: !hasErrors(checked) };
}

export async function loadLegacyBatch(db: Db, batchId: string) {
  const batch = await db.importBatch.findUnique({ where: { id: batchId }, include: { rows: { orderBy: { rowNo: "asc" } } } });
  if (!batch || batch.kind !== "LEGACY_LOANS" || !batch.header) return null;
  return {
    batch,
    stored: batch.header as unknown as StoredLegacyHeader,
    rows: batch.rows.map((r) => {
      const d = r.data as { raw: Record<string, string>; parsed: LegacyRowPlan | null };
      return { rowNo: r.rowNo, raw: d.raw, plan: d.parsed, errors: r.errors, loanId: r.entityId };
    }),
  };
}

/**
 * Finance Manager commits a checked file (PRD F8), all or nothing: someone
 * other than the uploader, only once the go-live date setting equals the
 * file's. Every loan gets a new CSS number, starts ACTIVE on the go-live
 * date and gets exactly one OPENING_BALANCE.
 */
export async function commitLegacyImport(db: PrismaClient, actor: LegacyActor, batchId: string, today: LocalDate = todayInLagos()) {
  const loaded = await loadLegacyBatch(db, batchId);
  if (!loaded || loaded.batch.status !== "PREVIEWED" || !loaded.batch.evidenceId) throw new LoanError("This import was already committed or rejected. Upload the file again.");
  const { batch, stored } = loaded;
  if (batch.uploadedById === actor.id) throw new LoanError("Someone other than the uploader must commit the legacy loans.");
  const goLiveSetting = await getDateSetting(db, "go_live_date", today);
  if (!goLiveSetting) throw new LoanError("The go-live date isn't set yet. Admin proposes it in Settings and Management approves it; then commit.");
  if (goLiveSetting !== stored.goLiveDate) throw new LoanError(`The file is for go-live ${stored.goLiveDate}, but the go-live date setting is ${goLiveSetting}. Upload the file again with the right date.`);
  if (compareDates(localDate(stored.goLiveDate), today) > 0) throw new LoanError(`Legacy loans are committed on or after the go-live date (${stored.goLiveDate}).`);

  const header = parseHeader(stored.input);
  const checked = await validateLegacyRows(db, header, batch.rows.map((r) => ({ rowNo: r.rowNo, values: (r.data as { raw: Record<string, string> }).raw })));
  if (hasErrors(checked)) {
    const errorRows = checked.rows.filter((r) => r.errors.length > 0);
    await db.$transaction([
      ...errorRows.map((r) => db.importRowLog.update({ where: { batchId_rowNo: { batchId: batch.id, rowNo: r.rowNo } }, data: { errors: r.errors } })),
      db.importBatch.update({ where: { id: batch.id }, data: { status: "REJECTED", errorRowCount: errorRows.length + (checked.batchErrors.length ? 1 : 0), header: { ...stored, batchErrors: checked.batchErrors } as unknown as Prisma.InputJsonValue } }),
    ]);
    throw new LoanError(`Nothing was imported: the file no longer passes every check (${[...checked.batchErrors, ...errorRows.map((r) => `row ${r.rowNo}: ${r.errors[0]}`)].join("; ")}).`);
  }

  const evidenceId = batch.evidenceId as string;
  const goLive = header.goLive;
  const now = new Date();
  const created: Array<{ loanId: string; loanAccountNo: string; rowNo: number }> = [];
  await db.$transaction(async (tx) => {
    const usedLegacy = new Set<string>();
    for (const r of checked.rows) {
      const p = r.data;
      const loanId = randomUUID();
      const loanAccountNo = await nextLoanNumber(tx, goLive);
      let legacyAccountNo = p.legacyAccountNo ?? `LEGACY-${p.pin}`;
      for (let n = 2; usedLegacy.has(legacyAccountNo) || (await tx.loan.findUnique({ where: { legacyAccountNo } })); n++) legacyAccountNo = `${p.legacyAccountNo ?? `LEGACY-${p.pin}`}-${n}`;
      usedLegacy.add(legacyAccountNo);
      const principal = BigInt(p.outstanding);
      const schedule = planSchedule({ principal: kobo(principal), tenure: p.tenure, rate: bps(BigInt(p.rateBps)), d0: goLive });
      await tx.loan.create({
        data: {
          id: loanId,
          loanAccountNo,
          legacyAccountNo,
          memberId: p.memberId,
          status: "ACTIVE",
          purpose: "Loan brought in from MOAUM's records at go-live",
          amountRequested: principal,
          tenureRequested: p.tenure,
          amountApproved: principal,
          tenureApproved: p.tenure,
          rateBps: p.rateBps,
          d0: toDbDate(goLive),
          bindingSchedule: JSON.parse(JSON.stringify(schedule, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Prisma.InputJsonValue,
          createdById: actor.id,
        },
      });
      await tx.loanTransition.create({ data: { loanId, fromStatus: null, toStatus: "ACTIVE", byUserId: actor.id, comment: `Legacy loan ${legacyAccountNo} brought in at go-live ${goLive}` } });
      await postEvent(tx, {
        occurredAt: toDbDate(goLive),
        moduleCode: "CREDIT",
        eventType: "OPENING_BALANCE",
        source: "LEGACY_IMPORT",
        evidenceRefs: [evidenceId],
        portalUserId: actor.id,
        moduleEntityType: "Loan",
        moduleEntityId: loanId,
        principalAmount: principal,
        uniquenessKey: `CREDIT:OPENING_BALANCE:LOAN:${loanId}`,
        metadata: {
          importBatchId: batch.id,
          legacyAccountNo,
          pin: p.pin,
          rateBps: p.rateBps,
          tenure: p.tenure,
          principalArrears: "0",
          interestArrears: "0",
          nextDueDate: schedule.installments[0]!.dueDate,
        },
      });
      await tx.evidenceLink.create({ data: { evidenceId, entityType: "Loan", entityId: loanId, kind: "PRIMARY", submissionKey: `LEGACY_IMPORT:${batch.id}`, linkedById: actor.id } });
      await tx.importRowLog.update({ where: { batchId_rowNo: { batchId: batch.id, rowNo: r.rowNo } }, data: { entityId: loanId } });
      created.push({ loanId, loanAccountNo, rowNo: r.rowNo });
    }
    await tx.importBatch.update({ where: { id: batch.id }, data: { status: "COMMITTED", committedById: actor.id, committedAt: now, errorRowCount: 0 } });
    await writeAudit(tx, {
      action: "legacyImport.commit",
      entityType: "ImportBatch",
      entityId: batch.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: evidenceId,
      after: { goLive, loans: created.length, outstanding: checked.total.toString(), uploadedById: batch.uploadedById },
    });
  }, LEGACY_TX);
  return { loans: created.length, total: checked.total };
}
