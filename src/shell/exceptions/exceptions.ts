import type { ExceptionRecord, Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";

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
  }
  return { exception, created: count === 1 };
}
