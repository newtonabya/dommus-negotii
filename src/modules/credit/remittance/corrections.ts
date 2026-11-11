import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { todayInLagos, type LocalDate } from "@/lib/dates";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { postEvent, reverseEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { getDateSetting } from "@/shell/settings/settings";
import type { PreviewRow } from "../imports/batches";
import { applyRecompute, planRecompute } from "../loans/repayments";
import { naira, REMITTANCE_TX, RemittanceError, type RemittanceActor } from "./common";
import { checkScheduleRows, matchAdvice, readScheduleFile, type AdviceMatchLine, type RawRow, type ScheduleRowPlan } from "./schedules";
import { currentAdviceOf, type UploadedFile } from "./source-advice";
import { tellStaff } from "../notices";

/** What a prepared correction holds; re-checked when it is verified. */
interface CorrectionPayload {
  reverseRowIds: string[];
  replacements: RawRow[];
  replacementFile: { evidenceId: string; filename: string } | null;
}

export interface CorrectionInput {
  reason: string;
  reverseRowIds: string[];
  /** For a payroll voucher of replacement rows (it has no dates). */
  paymentDate?: string;
}

async function loadSchedule(db: Db, scheduleId: string) {
  const schedule = await db.remittanceSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      remittanceSource: true,
      rows: { include: { member: { select: { moaumIdNumber: true, fullName: true } } }, orderBy: { rowNo: "asc" } },
    },
  });
  if (!schedule) throw new RemittanceError("Schedule not found.");
  return schedule;
}

type LoadedSchedule = Awaited<ReturnType<typeof loadSchedule>>;

/**
 * Everything a correction must satisfy (PRD F9): the rows it reverses are live
 * rows of the schedule, replacement rows pass every row check and duplicate
 * no remaining row, and afterwards the schedule's payroll rows match its
 * (possibly superseding) Source Advice member by member.
 */
export async function evaluateCorrection(db: Db, schedule: LoadedSchedule, payload: CorrectionPayload, today: LocalDate = todayInLagos()) {
  const errors: string[] = [];
  const live = schedule.rows.filter((r) => r.reversedAt === null);
  const liveIds = new Set(live.map((r) => r.id));
  const reverse = new Set(payload.reverseRowIds);
  for (const id of reverse) if (!liveIds.has(id)) errors.push("A row chosen for reversal is not a live row of this schedule. Reload and choose again.");
  if (reverse.size === 0 && payload.replacements.length === 0) errors.push("Choose rows to reverse or add replacement rows.");

  const goLive = await getDateSetting(db, "go_live_date", today);
  const replacements: PreviewRow<ScheduleRowPlan>[] = await checkScheduleRows(
    db,
    { remittanceSourceId: schedule.remittanceSourceId, sourceCode: schedule.remittanceSource.code, monthCovered: schedule.monthCovered },
    payload.replacements,
    today,
    goLive,
  );
  if (live.some((r) => reverse.has(r.id) && r.rowType === "DIRECT")) errors.push("DIRECT rows can't be reversed by a correction yet: their bank credit stays verified. Ask the developer.");
  if (reverse.size) {
    const moved = await db.reclassification.count({ where: { rowId: { in: [...reverse] }, status: { in: ["PREPARED", "VERIFIED"] } } });
    if (moved) errors.push("A row chosen for reversal has part of it moved to Overpayment Credit (a reclassification). It can't be corrected away.");
  }
  for (const r of replacements) if (r.data.rowType === "DIRECT") r.errors.push("Replacement rows must be PAYROLL rows.");
  const remaining = live.filter((r) => !reverse.has(r.id));
  const remainingHashes = new Map(remaining.map((r) => [r.rowHash, r.rowNo]));
  for (const r of replacements) {
    const same = remainingHashes.get(r.data.rowHash);
    if (same !== undefined) r.errors.push(`Same payment as live row ${same} of the schedule (a duplicate row).`);
  }

  const advice = await currentAdviceOf(db, schedule);
  const remainingEntries = remaining
    .filter((r) => r.rowType === "PAYROLL")
    .map((r) => ({ moaumIdNumber: r.member.moaumIdNumber.toUpperCase(), name: r.member.fullName, amount: r.amount, errors: [] as string[], rowNo: r.rowNo }));
  const matched = matchAdvice(
    [
      ...remainingEntries,
      ...replacements.filter((r) => r.data.rowType === "PAYROLL").map((r) => ({ moaumIdNumber: r.data.moaumIdNumber, name: r.data.memberName, amount: BigInt(r.data.amount), errors: r.errors })),
    ],
    advice,
  );
  for (const e of remainingEntries) if (e.errors.length) errors.push(`Row ${e.rowNo} (${e.name}) after the correction: ${e.errors[0]}`);
  errors.push(...matched.missing.map((m) => `${m} but has no rows after the correction.`));
  for (const r of replacements) if (r.errors.length) errors.push(`Replacement row ${r.rowNo}: ${r.errors.join(" ")}`);

  const reversedTotal = live.filter((r) => reverse.has(r.id)).reduce((t, r) => t + r.amount, 0n);
  const addedTotal = replacements.reduce((t, r) => t + BigInt(r.data.amount), 0n);
  return {
    errors: [...new Set(errors)],
    replacements,
    reversed: live.filter((r) => reverse.has(r.id)),
    advice,
    adviceMatch: matched.lines as AdviceMatchLine[],
    totals: { reversed: reversedTotal, added: addedTotal, liveAfter: remaining.reduce((t, r) => t + r.amount, 0n) + addedTotal },
  };
}

/**
 * Treasurer prepares a correction of their own posted schedule (PRD F9): rows
 * to reverse and/or replacement rows, with a reason and evidence. Nothing is
 * posted until the Finance Manager verifies it.
 */
export async function prepareCorrection(
  db: PrismaClient,
  store: EvidenceStore,
  actor: RemittanceActor,
  scheduleId: string,
  input: CorrectionInput,
  evidence: UploadedFile,
  replacementFile: UploadedFile | null,
) {
  const schedule = await loadSchedule(db, scheduleId);
  if (schedule.uploadedById !== actor.id) throw new RemittanceError("Only the Treasurer who posted this schedule can prepare its corrections.");
  const reason = input.reason.trim();
  if (reason.length < 10) throw new RemittanceError("Say why the schedule is being corrected (at least 10 characters).");
  if (evidence.bytes.length === 0) throw new RemittanceError("Attach the document that explains the correction.");
  const open = await db.correctionBatch.findFirst({ where: { scheduleId, status: "PREPARED" } });
  if (open) throw new RemittanceError("This schedule already has a correction waiting for the Finance Manager.");

  const replacements = replacementFile ? (await readScheduleFile(schedule, { paymentDate: input.paymentDate }, replacementFile)).rows : [];
  const payload: CorrectionPayload = { reverseRowIds: [...new Set(input.reverseRowIds)], replacements, replacementFile: null };
  const checked = await evaluateCorrection(db, schedule, payload);
  if (checked.errors.length > 0) throw new RemittanceError("The correction was not saved. Fix these and try again:", checked.errors);

  const doc = await storeEvidenceBytes(db, store, actor, evidence.filename, evidence.bytes);
  if (replacementFile) {
    const file = await storeEvidenceBytes(db, store, actor, replacementFile.filename, replacementFile.bytes);
    payload.replacementFile = { evidenceId: file.evidenceId, filename: replacementFile.filename };
  }
  const correction = await db.correctionBatch.create({
    data: {
      scheduleId,
      reason,
      evidenceId: doc.evidenceId,
      adviceId: checked.advice.id,
      payload: payload as unknown as Prisma.InputJsonValue,
      preparedById: actor.id,
    },
  });
  await writeAudit(db, {
    action: "correction.prepare",
    entityType: "CorrectionBatch",
    entityId: correction.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    evidenceRef: doc.evidenceId,
    after: {
      scheduleId,
      reason,
      reverse: payload.reverseRowIds.length,
      replacements: replacements.length,
      reversedTotal: checked.totals.reversed.toString(),
      addedTotal: checked.totals.added.toString(),
      advice: checked.advice.adviceReference,
    },
  });
  await tellStaff(db, ["FINANCE_MANAGER"], `correction.prepared:${correction.id}`, "staff.correction.prepared", "A schedule correction waits for verification", `A correction to a posted schedule was prepared and waits for your verification.\n\nReason: ${reason}`, actor.id);
  return correction;
}

async function loadPrepared(db: Db, correctionId: string, actor: RemittanceActor) {
  const correction = await db.correctionBatch.findUnique({ where: { id: correctionId } });
  if (!correction) throw new RemittanceError("Correction not found.");
  if (correction.status !== "PREPARED") throw new RemittanceError("This correction has already been decided.");
  if (correction.preparedById === actor.id) throw new RemittanceError("Someone else must verify a correction you prepared.");
  return correction;
}

export interface VerifyHooks {
  /** Tests only: runs inside the transaction after the loans are recomputed. */
  beforeFinish?: (tx: Db) => Promise<void>;
}

/**
 * Finance Manager verifies a correction (PRD F9): every check runs again, then
 * in one transaction the rows are reversed, replacements added, Overpayment
 * Credits reversed or posted, every affected loan recomputed, and a
 * superseding advice takes over the schedule.
 */
export async function verifyCorrection(db: PrismaClient, actor: RemittanceActor, correctionId: string, hooks: VerifyHooks = {}) {
  const correction = await loadPrepared(db, correctionId, actor);
  const schedule = await loadSchedule(db, correction.scheduleId);
  const payload = correction.payload as unknown as CorrectionPayload;
  const today = todayInLagos();
  const checked = await evaluateCorrection(db, schedule, payload, today);
  if (checked.errors.length > 0) throw new RemittanceError("The correction can't be posted as it stands. Return it to the Treasurer:", checked.errors);

  const now = new Date();
  const trigger = `CORRECTION:${correction.id}`;
  const reason = `Correction of schedule ${schedule.scheduleReference}: ${correction.reason}`;
  const evidenceId = correction.evidenceId;
  const lastRowNo = schedule.rows.reduce((m, r) => Math.max(m, r.rowNo), 0);
  const added = checked.replacements.map((r, i) => ({ id: randomUUID(), rowNo: lastRowNo + 1 + i, plan: r.data }));

  await db.$transaction(async (tx) => {
    const { count } = await tx.correctionBatch.updateMany({
      where: { id: correction.id, status: "PREPARED" },
      data: { status: "VERIFIED", decidedById: actor.id, decidedAt: now, adviceId: checked.advice.id },
    });
    if (count !== 1) throw new RemittanceError("This correction was decided by someone else just now.");

    // Reverse the rows first: a replacement may repeat a reversed payment.
    if (checked.reversed.length) {
      await tx.remittanceRow.updateMany({ where: { id: { in: checked.reversed.map((r) => r.id) }, reversedAt: null }, data: { reversedAt: now, reversedById: correction.id } });
    }
    for (const row of checked.reversed.filter((r) => r.toCredit)) {
      const credited = await tx.ledgerEvent.findUnique({ where: { uniquenessKey: `CREDIT:ROW:${row.id}:CREDIT` } });
      if (credited) {
        await reverseEvent(tx, credited.id, { uniquenessKey: `CREDIT:REV:${credited.id}`, occurredAt: now, portalUserId: actor.id, evidenceRefs: [evidenceId], reason });
      }
    }
    if (added.length) {
      await tx.remittanceRow.createMany({
        data: added.map(({ id, rowNo, plan }) => ({
          id,
          scheduleId: schedule.id,
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
          correctionId: correction.id,
        })),
      });
    }
    for (const { id, plan } of added.filter((a) => a.plan.toCredit)) {
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
        metadata: { rowId: id, scheduleId: schedule.id, correctionId: correction.id, reason: plan.creditReason, loanAccountNo: plan.loanAccountNo },
      });
    }

    // Every loan the correction touches is recomputed from all its payments (PRD F6).
    const loanIds = new Set<string>();
    for (const r of checked.reversed) if (r.loanId && !r.toCredit) loanIds.add(r.loanId);
    for (const a of added) if (a.plan.loanId && !a.plan.toCredit) loanIds.add(a.plan.loanId);
    for (const loanId of loanIds) {
      const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
      const plan = await planRecompute(tx, loan, today);
      await applyRecompute(tx, loan, plan, { actor, trigger, evidenceId, reason, now });
    }

    // A superseding advice takes over the schedule.
    if (checked.advice.id !== schedule.adviceId) {
      // Advices between the two in the chain were superseded when their replacement was uploaded.
      await tx.sourceAdvice.updateMany({ where: { id: schedule.adviceId }, data: { status: "SUPERSEDED" } });
      const { count: taken } = await tx.sourceAdvice.updateMany({ where: { id: checked.advice.id, status: "AVAILABLE" }, data: { status: "USED" } });
      if (taken !== 1) throw new RemittanceError("The superseding advice was used elsewhere just now.");
      await tx.remittanceSchedule.update({ where: { id: schedule.id }, data: { adviceId: checked.advice.id } });
    }
    await hooks.beforeFinish?.(tx);

    await linkEvidence(tx, actor, { evidenceId, entityType: "CorrectionBatch", entityId: correction.id, kind: "PRIMARY", submissionKey: `CORRECTION:${correction.id}` });
    await writeAudit(tx, {
      action: "correction.verify",
      entityType: "CorrectionBatch",
      entityId: correction.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: evidenceId,
      after: {
        scheduleId: schedule.id,
        reversed: checked.reversed.map((r) => r.rowNo),
        added: added.map((a) => a.rowNo),
        reversedTotal: checked.totals.reversed.toString(),
        addedTotal: checked.totals.added.toString(),
        loans: loanIds.size,
        advice: checked.advice.adviceReference,
      },
    });
  }, REMITTANCE_TX);

  return { reversed: checked.reversed.length, added: added.length, net: naira(checked.totals.added - checked.totals.reversed) };
}

/** Finance Manager sends a correction back with a reason; nothing is posted. */
export async function returnCorrection(db: Db, actor: RemittanceActor, correctionId: string, comment: string) {
  const text = comment.trim();
  if (text.length < 5) throw new RemittanceError("Say why the correction is returned.");
  const correction = await loadPrepared(db, correctionId, actor);
  const { count } = await db.correctionBatch.updateMany({
    where: { id: correction.id, status: "PREPARED" },
    data: { status: "RETURNED", decidedById: actor.id, decidedAt: new Date(), returnComment: text },
  });
  if (count !== 1) throw new RemittanceError("This correction was decided by someone else just now.");
  await writeAudit(db, {
    action: "correction.return",
    entityType: "CorrectionBatch",
    entityId: correction.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { scheduleId: correction.scheduleId, comment: text },
  });
}

/** A schedule's corrections, newest first, with the pending one evaluated for the reviewer. */
export async function scheduleCorrections(db: Db, scheduleId: string) {
  const corrections = await db.correctionBatch.findMany({ where: { scheduleId }, orderBy: { preparedAt: "desc" }, include: { advice: { select: { adviceReference: true } } } });
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(corrections.flatMap((c) => [c.preparedById, c.decidedById ?? ""]))] } },
    select: { id: true, name: true },
  });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? "Unknown") : "");
  const pending = corrections.find((c) => c.status === "PREPARED");
  const evaluation = pending ? await evaluateCorrection(db, await loadSchedule(db, scheduleId), pending.payload as unknown as CorrectionPayload) : null;
  return {
    corrections: corrections.map((c) => ({ ...c, preparedByName: name(c.preparedById), decidedByName: name(c.decidedById), payload: c.payload as unknown as CorrectionPayload })),
    pending: pending && evaluation ? { correction: pending, evaluation } : null,
  };
}
