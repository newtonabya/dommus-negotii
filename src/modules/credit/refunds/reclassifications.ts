import type { PrismaClient } from "@/generated/prisma/client";
import { type Db } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { formatNaira, kobo, parseNaira } from "@/lib/money";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { assertNotSelfDealing } from "@/shell/rbac/permissions";
import { applyRecompute, loanLiveState, planRecompute } from "../loans/repayments";
import { REMITTANCE_TX } from "../remittance/common";
import { RefundError, type RefundActor } from "./refunds";

/**
 * Refund instead of principal reduction (PRD F12): part of a posted repayment
 * that went to principal is moved to the member's Overpayment Credit, at the
 * member's request, before the next REGULAR schedule for their payroll source
 * posts. The Treasurer prepares it, the Finance Manager verifies it; the loan
 * is recomputed as if that part had never been paid, and DEPOSIT_CREDITED
 * posts. The refund itself then follows the usual steps.
 */
const naira = (v: bigint) => formatNaira(kobo(v));

async function loadRow(db: Db, rowId: string) {
  const row = await db.remittanceRow.findUnique({
    where: { id: rowId },
    include: {
      schedule: { select: { id: true, remittanceSourceId: true, monthCovered: true, scheduleReference: true } },
      loan: true,
      reclassifications: { where: { status: { in: ["PREPARED", "VERIFIED"] } } },
    },
  });
  if (!row || !row.loan || row.toCredit || row.reversedAt) throw new RefundError("Choose a live repayment that went to a loan.");
  return row as typeof row & { loan: NonNullable<typeof row.loan> };
}

/** Everything a reclassification must satisfy, checked when prepared and again when verified. */
async function check(db: Db, row: Awaited<ReturnType<typeof loadRow>>, amount: bigint, exceptId?: string) {
  const later = await db.remittanceSchedule.findFirst({
    where: { remittanceSourceId: row.schedule.remittanceSourceId, type: "REGULAR", monthCovered: { gt: row.schedule.monthCovered } },
    select: { scheduleReference: true, monthCovered: true },
  });
  if (later) throw new RefundError(`Too late: the next regular schedule (${later.scheduleReference}, ${later.monthCovered}) has already posted. The prepayment stays on the loan.`);
  const live = await loanLiveState(db, row.loan, todayInLagos());
  const principal = live?.repayments.find((r) => r.id === row.id)?.principal ?? 0n;
  const pending = row.reclassifications.filter((r) => r.status === "PREPARED" && r.id !== exceptId).reduce((t, r) => t + r.amount, 0n);
  const movable = principal - pending;
  if (amount <= 0n) throw new RefundError("The amount must be more than ₦0.");
  if (amount > movable) throw new RefundError(`At most ${naira(movable > 0n ? movable : 0n)} of this repayment went to principal and can be moved.`);
}

export async function prepareReclassification(
  db: PrismaClient,
  store: EvidenceStore,
  actor: RefundActor,
  input: { rowId: string; amount: string; reason: string },
  request: { filename: string; bytes: Uint8Array },
) {
  const row = await loadRow(db, input.rowId);
  const own = await db.member.findUnique({ where: { userId: actor.id }, select: { id: true } });
  assertNotSelfDealing(own?.id ?? null, row.memberId);
  let amount: bigint;
  try {
    amount = parseNaira(input.amount.trim());
  } catch {
    throw new RefundError("Enter the amount in naira.");
  }
  const reason = input.reason.trim();
  if (reason.length < 10) throw new RefundError("Give the reason (at least 10 characters), e.g. the member's request.");
  if (request.bytes.length === 0) throw new RefundError("Attach the member's request.");
  await check(db, row, amount);
  const file = await storeEvidenceBytes(db, store, actor, request.filename, request.bytes);
  const reclass = await db.reclassification.create({ data: { rowId: row.id, amount, reason: reason.slice(0, 300), evidenceId: file.evidenceId, preparedById: actor.id } });
  await writeAudit(db, { action: "reclassification.prepare", entityType: "Reclassification", entityId: reclass.id, userId: actor.id, ipAddress: actor.ipAddress, evidenceRef: file.evidenceId, after: { rowId: row.id, loanId: row.loanId, amount: amount.toString() } });
  return reclass;
}

async function prepared(db: Db, id: string, actor: RefundActor) {
  const reclass = await db.reclassification.findUnique({ where: { id } });
  if (!reclass) throw new RefundError("Reclassification not found.");
  if (reclass.status !== "PREPARED") throw new RefundError("This reclassification has already been decided.");
  if (reclass.preparedById === actor.id) throw new RefundError("Someone else must verify a reclassification you prepared.");
  return reclass;
}

/** Finance Manager verifies: the loan is recomputed without the amount and DEPOSIT_CREDITED posts, in one transaction. */
export async function verifyReclassification(db: PrismaClient, actor: RefundActor, id: string) {
  const reclass = await prepared(db, id, actor);
  const row = await loadRow(db, reclass.rowId);
  const own = await db.member.findUnique({ where: { userId: actor.id }, select: { id: true } });
  assertNotSelfDealing(own?.id ?? null, row.memberId);
  await check(db, row, reclass.amount, reclass.id);
  const now = new Date();
  await db.$transaction(async (tx) => {
    const { count } = await tx.reclassification.updateMany({ where: { id, status: "PREPARED" }, data: { status: "VERIFIED", decidedById: actor.id, decidedAt: now } });
    if (count !== 1) throw new RefundError("This reclassification was decided by someone else just now.");
    await postEvent(tx, {
      occurredAt: row.paymentDate,
      moduleCode: "CREDIT",
      eventType: "DEPOSIT_CREDITED",
      source: "REMITTANCE_SCHEDULE",
      evidenceRefs: [reclass.evidenceId],
      portalUserId: actor.id,
      moduleEntityType: "Member",
      moduleEntityId: row.memberId,
      depositDelta: reclass.amount,
      uniquenessKey: `CREDIT:RECLASS:${reclass.id}`,
      // No `loanId` key: that marks the engine's own overpayment allocations.
      metadata: { reclassificationId: reclass.id, rowId: row.id, sourceLoanId: row.loanId, reason: reclass.reason },
    });
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: row.loan.id } });
    const plan = await planRecompute(tx, loan, todayInLagos());
    await applyRecompute(tx, loan, plan, { actor, trigger: `RECLASS:${reclass.id}`, evidenceId: reclass.evidenceId, reason: `Prepayment moved to Overpayment Credit: ${reclass.reason}`, now });
    await linkEvidence(tx, actor, { evidenceId: reclass.evidenceId, entityType: "Reclassification", entityId: reclass.id, kind: "PRIMARY", submissionKey: `RECLASSIFICATION:${reclass.id}` });
    await writeAudit(tx, { action: "reclassification.verify", entityType: "Reclassification", entityId: id, userId: actor.id, ipAddress: actor.ipAddress, evidenceRef: reclass.evidenceId, after: { rowId: row.id, loanId: row.loanId, amount: reclass.amount.toString() } });
  }, REMITTANCE_TX);
}

export async function returnReclassification(db: Db, actor: RefundActor, id: string, comment: string) {
  const why = comment.trim();
  if (why.length < 5) throw new RefundError("Say why it goes back to the Treasurer.");
  await prepared(db, id, actor);
  const { count } = await db.reclassification.updateMany({ where: { id, status: "PREPARED" }, data: { status: "RETURNED", decidedById: actor.id, decidedAt: new Date(), returnComment: why } });
  if (count !== 1) throw new RefundError("This reclassification was decided by someone else just now.");
  await writeAudit(db, { action: "reclassification.return", entityType: "Reclassification", entityId: id, userId: actor.id, ipAddress: actor.ipAddress, after: { comment: why } });
}

export async function listReclassifications(db: Db, take = 50) {
  return db.reclassification.findMany({
    orderBy: { preparedAt: "desc" },
    take,
    include: { row: { include: { member: { select: { fullName: true, memberNo: true } }, loan: { select: { loanAccountNo: true, legacyAccountNo: true } }, schedule: { select: { scheduleReference: true } } } } },
  });
}

/** Repayments on a loan that could be reclassified, for the Treasurer's form. */
export async function reclassifiableRows(db: Db, loanAccountNo: string) {
  const loan = await db.loan.findFirst({ where: { OR: [{ loanAccountNo: loanAccountNo.trim().toUpperCase() }, { legacyAccountNo: loanAccountNo.trim().toUpperCase() }] } });
  if (!loan) return null;
  const live = await loanLiveState(db, loan, todayInLagos());
  return { loan, repayments: live?.repayments.filter((r) => r.principal > 0n) ?? [] };
}
