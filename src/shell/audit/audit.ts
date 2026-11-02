import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  userId?: string | null;
  ipAddress?: string | null;
  before?: unknown;
  after?: unknown;
  evidenceRef?: string | null;
}

function json(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  // Round-trip through JSON so Dates and bigints are stored as strings.
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

/** Appends to the insert-only audit trail (PRD F2). */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      userId: entry.userId ?? null,
      ipAddress: entry.ipAddress ?? null,
      before: json(entry.before),
      after: json(entry.after),
      evidenceRef: entry.evidenceRef ?? null,
    },
  });
}
