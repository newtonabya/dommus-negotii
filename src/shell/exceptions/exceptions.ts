import type { ExceptionRecord, Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { queueForRoles } from "@/shell/notifications/messages";

export interface RaiseExceptionInput {
  moduleCode: string;
  /** e.g. DUPLICATE_EVIDENCE, EVIDENCE_TAMPERED, SHORTFALL. */
  type: string;
  /** Same key → the same exception; raising again returns the existing one. */
  dedupeKey: string;
  title: string;
  details?: Record<string, unknown>;
  /** Kobo, when the exception is about an amount. */
  amount?: bigint | null;
  raisedById?: string | null;
  ipAddress?: string | null;
}

/**
 * Opens an exception in the portal-wide register (PRD F11). Idempotent: a
 * second call with the same dedupeKey returns the existing record unchanged.
 */
export async function raiseException(
  db: Db,
  input: RaiseExceptionInput,
): Promise<{ exception: ExceptionRecord; created: boolean }> {
  const { count } = await db.exceptionRecord.createMany({
    data: [
      {
        moduleCode: input.moduleCode,
        type: input.type,
        dedupeKey: input.dedupeKey,
        title: input.title,
        details: (input.details ?? {}) as Prisma.InputJsonObject,
        amount: input.amount ?? null,
        raisedById: input.raisedById ?? null,
      },
    ],
    skipDuplicates: true,
  });
  const exception = await db.exceptionRecord.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
  if (count === 1) {
    await writeAudit(db, {
      action: "exception.raise",
      entityType: "Exception",
      entityId: exception.id,
      userId: input.raisedById ?? null,
      ipAddress: input.ipAddress ?? null,
      after: { type: input.type, title: input.title, details: input.details ?? {} },
    });
    await queueForRoles(db, ["FINANCE_MANAGER", "GMD"], {
      key: `exception.raised:${exception.id}`,
      template: input.type === "DUPLICATE_EVIDENCE" ? "staff.exception.duplicate_evidence" : "staff.exception.raised",
      subject: `New exception: ${input.title}`.slice(0, 150),
      text: `A new exception was raised: ${input.title}.\n\nThe Finance Manager reviews it; the GMD closes it. See Exceptions in Dommus Negotii.`,
    });
  }
  return { exception, created: count === 1 };
}

/** Messages from this error are written for the user and safe to show. */
export class ExceptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExceptionError";
  }
}

export interface ExceptionActor {
  id: string;
  ipAddress: string | null;
}

/**
 * Updates what an open exception is about (a rerun found a new amount, or the
 * underlying item was resolved). A closed exception is never touched.
 */
export async function refreshException(db: Db, dedupeKey: string, change: { amount?: bigint | null; details?: Record<string, unknown> }) {
  const current = await db.exceptionRecord.findUnique({ where: { dedupeKey } });
  if (!current || current.status === "CLOSED") return current;
  return db.exceptionRecord.update({
    where: { dedupeKey },
    data: {
      ...(change.amount !== undefined ? { amount: change.amount } : {}),
      ...(change.details ? { details: { ...(current.details as Record<string, unknown>), ...change.details } as Prisma.InputJsonObject } : {}),
    },
  });
}

/**
 * The Finance Manager reviews an exception (PRD F11): OPEN → UNDER_REVIEW,
 * adding a note and, optionally, supporting evidence. Notes accumulate.
 */
export async function reviewException(db: Db, actor: ExceptionActor, id: string, note: string, evidenceId: string | null) {
  const text = note.trim();
  if (text.length < 5) throw new ExceptionError("Write what you found (at least 5 characters).");
  const ex = await db.exceptionRecord.findUnique({ where: { id } });
  if (!ex) throw new ExceptionError("Exception not found.");
  if (ex.status === "CLOSED") throw new ExceptionError("This exception is closed.");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const notes = [ex.reviewNote, `${stamp}: ${text}`].filter(Boolean).join("\n");
  await db.exceptionRecord.update({ where: { id }, data: { status: "UNDER_REVIEW", reviewedById: actor.id, reviewedAt: new Date(), reviewNote: notes } });
  if (evidenceId) {
    await db.evidenceLink.createMany({
      data: [{ evidenceId, entityType: "Exception", entityId: id, kind: "SUPPORTING", submissionKey: `EXCEPTION:${id}`, linkedById: actor.id }],
      skipDuplicates: true,
    });
  }
  await writeAudit(db, { action: "exception.review", entityType: "Exception", entityId: id, userId: actor.id, ipAddress: actor.ipAddress, evidenceRef: evidenceId, after: { note: text } });
}

/**
 * The GMD closes a reviewed exception (PRD F11), only once it is confirmed:
 * a reason and the evidence (matching bank evidence or a documented
 * explanation). Closing never changes the ledger or any balance.
 */
export async function closeException(db: Db, actor: ExceptionActor, id: string, reason: string, evidenceId: string | null) {
  const why = reason.trim();
  if (why.length < 10) throw new ExceptionError("Give the reason it is closed (at least 10 characters).");
  if (!evidenceId) throw new ExceptionError("Attach the evidence that confirms it: the bank evidence or a documented explanation.");
  const ex = await db.exceptionRecord.findUnique({ where: { id } });
  if (!ex) throw new ExceptionError("Exception not found.");
  if (ex.status !== "UNDER_REVIEW") throw new ExceptionError("Only an exception the Finance Manager has reviewed can be closed.");
  const { count } = await db.exceptionRecord.updateMany({
    where: { id, status: "UNDER_REVIEW" },
    data: { status: "CLOSED", closedById: actor.id, closedAt: new Date(), closeReason: why, closeEvidenceId: evidenceId },
  });
  if (count !== 1) throw new ExceptionError("This exception changed just now; reload.");
  await db.evidenceLink.createMany({
    data: [{ evidenceId, entityType: "Exception", entityId: id, kind: "SUPPORTING", submissionKey: `EXCEPTION:${id}`, linkedById: actor.id }],
    skipDuplicates: true,
  });
  await writeAudit(db, { action: "exception.close", entityType: "Exception", entityId: id, userId: actor.id, ipAddress: actor.ipAddress, evidenceRef: evidenceId, after: { reason: why } });
}

/** Exceptions for the register page: open first, then the latest closed. */
export async function listExceptions(db: Db, options: { status?: "OPEN" | "UNDER_REVIEW" | "CLOSED" | "ACTIVE"; take?: number } = {}) {
  const where = options.status === "ACTIVE" || !options.status ? { status: { not: "CLOSED" as const } } : { status: options.status };
  return db.exceptionRecord.findMany({ where, orderBy: [{ status: "asc" }, { raisedAt: "asc" }], take: options.take ?? 300 });
}
