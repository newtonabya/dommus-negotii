import type { LedgerEvent, Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import {
  MONEY_FIELDS,
  negatedAmounts,
  newLedgerEventSchema,
  SCHEMA_VERSION,
  type MoneyField,
  type NewLedgerEvent,
  type ValidLedgerEvent,
} from "./events";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface PostResult {
  event: LedgerEvent;
  /** False when the uniqueness key already existed and the existing event was returned. */
  created: boolean;
}

function toCreateData(e: ValidLedgerEvent, reversesEventId: string | null): Prisma.LedgerEventCreateManyInput {
  return {
    occurredAt: e.occurredAt,
    moduleCode: e.moduleCode,
    eventType: e.eventType,
    source: e.source,
    evidenceRefs: e.evidenceRefs,
    portalUserId: e.portalUserId,
    moduleEntityType: e.moduleEntityType,
    moduleEntityId: e.moduleEntityId,
    bankAccountId: e.bankAccountId,
    currency: e.currency,
    cashAmount: e.cashAmount,
    revenueAmount: e.revenueAmount,
    depositDelta: e.depositDelta,
    principalAmount: e.principalAmount,
    interestAmount: e.interestAmount,
    retentionAmount: e.retentionAmount,
    uniquenessKey: e.uniquenessKey,
    reversesEventId,
    schemaVersion: SCHEMA_VERSION,
    metadata: e.metadata as Prisma.InputJsonValue,
  };
}

function sameEffect(existing: LedgerEvent, wanted: Prisma.LedgerEventCreateManyInput): boolean {
  return (
    existing.eventType === wanted.eventType &&
    existing.moduleEntityId === wanted.moduleEntityId &&
    (existing.reversesEventId ?? null) === (wanted.reversesEventId ?? null) &&
    MONEY_FIELDS.every((f) => existing[f] === (wanted[f] ?? 0n))
  );
}

/**
 * Appends an event idempotently (PRD F4). Uses INSERT … ON CONFLICT DO NOTHING
 * so a duplicate key never aborts the surrounding transaction; re-posting the
 * same key returns the existing event. Reusing a key for a different effect is
 * a bug and throws.
 */
async function insertOnce(db: Db, data: Prisma.LedgerEventCreateManyInput): Promise<PostResult> {
  const { count } = await db.ledgerEvent.createMany({ data: [data], skipDuplicates: true });
  const event = await db.ledgerEvent.findUnique({ where: { uniquenessKey: data.uniquenessKey } });
  if (!event) throw new LedgerError(`Event ${data.uniquenessKey} was neither inserted nor found`);
  if (count === 0 && !sameEffect(event, data)) {
    throw new LedgerError(`Uniqueness key ${data.uniquenessKey} already used for a different event`);
  }
  return { event, created: count === 1 };
}

export async function postEvent(db: Db, input: NewLedgerEvent): Promise<PostResult> {
  const event = newLedgerEventSchema.parse(input);
  return insertOnce(db, toCreateData(event, null));
}

export interface ReversalInput {
  uniquenessKey: string;
  occurredAt: Date;
  portalUserId: string;
  evidenceRefs: string[];
  reason: string;
}

/** Builds the reversal of `original`: same type and entity, exactly negated amounts. */
export function buildReversal(original: LedgerEvent, input: ReversalInput): Prisma.LedgerEventCreateManyInput {
  if (original.reversesEventId !== null) throw new LedgerError("A reversal cannot itself be reversed");
  if (input.evidenceRefs.length === 0) throw new LedgerError("A reversal needs evidence");
  if (input.reason.trim() === "") throw new LedgerError("A reversal needs a reason");
  const amounts: Record<MoneyField, bigint> = negatedAmounts(original);
  return {
    occurredAt: input.occurredAt,
    moduleCode: original.moduleCode,
    eventType: original.eventType,
    source: original.source,
    evidenceRefs: input.evidenceRefs,
    portalUserId: input.portalUserId,
    moduleEntityType: original.moduleEntityType,
    moduleEntityId: original.moduleEntityId,
    bankAccountId: original.bankAccountId,
    currency: original.currency,
    ...amounts,
    uniquenessKey: input.uniquenessKey,
    reversesEventId: original.id,
    schemaVersion: SCHEMA_VERSION,
    metadata: { reason: input.reason } satisfies Prisma.InputJsonObject,
  };
}

/** Appends the reversal of an event (PRD F4). Idempotent on `uniquenessKey`. */
export async function reverseEvent(db: Db, originalId: string, input: ReversalInput): Promise<PostResult> {
  const original = await db.ledgerEvent.findUnique({ where: { id: originalId } });
  if (!original) throw new LedgerError(`Event ${originalId} not found`);
  const existing = await db.ledgerEvent.findUnique({ where: { reversesEventId: originalId } });
  if (existing && existing.uniquenessKey !== input.uniquenessKey) {
    throw new LedgerError(`Event ${originalId} is already reversed by ${existing.id}`);
  }
  return insertOnce(db, buildReversal(original, input));
}
