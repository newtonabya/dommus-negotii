import { z } from "zod";

/** Ledger event schema version (PRD F4). */
export const SCHEMA_VERSION = 2;

/** Phase 1 event types (PRD F4). BANK_DEPOSIT is reserved and unused. */
export const EVENT_TYPES = [
  "OPENING_BALANCE",
  "CASH_IN",
  "CASH_OUT",
  "PRINCIPAL_RECOVERY",
  "INTEREST_INCOME",
  "DEPOSIT_CREDITED",
  "DEPOSIT_REFUNDED",
  "SCHEDULE_ACCEPTED",
  "SCHEDULE_POSTED",
  "LODGEMENT_BANK_VERIFIED",
  "LODGEMENT_APPLIED",
  "LODGEMENT_UNAPPLIED",
  "BANK_DEPOSIT",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RESERVED_EVENT_TYPES: readonly EventType[] = ["BANK_DEPOSIT"];

/** Status events carry their amount in metadata and zero in every money field. */
export const STATUS_EVENT_TYPES: readonly EventType[] = [
  "SCHEDULE_ACCEPTED",
  "SCHEDULE_POSTED",
  "LODGEMENT_BANK_VERIFIED",
  "LODGEMENT_APPLIED",
  "LODGEMENT_UNAPPLIED",
];

export const SOURCES = [
  "REMITTANCE_SCHEDULE",
  "BANK_SLIP",
  "BANK_STATEMENT",
  "DISBURSEMENT_VOUCHER",
  "REFUND_VOUCHER",
  "LEGACY_IMPORT",
  "RECEIPT_ENTRY",
  "EXCEL_BATCH",
  "LIVE_PAYMENT",
] as const;
export type Source = (typeof SOURCES)[number];

export const RESERVED_SOURCES: readonly Source[] = ["RECEIPT_ENTRY", "EXCEL_BATCH", "LIVE_PAYMENT"];

export const MONEY_FIELDS = [
  "cashAmount",
  "revenueAmount",
  "depositDelta",
  "principalAmount",
  "interestAmount",
  "retentionAmount",
] as const;
export type MoneyField = (typeof MONEY_FIELDS)[number];

const kobo = z.bigint();

/** Input for posting a new (non-reversal) event. */
export const newLedgerEventSchema = z
  .object({
    occurredAt: z.date(),
    moduleCode: z.string().min(1),
    eventType: z.enum(EVENT_TYPES),
    source: z.enum(SOURCES),
    evidenceRefs: z.array(z.uuid()).min(1, "Every ledger event needs evidence"),
    portalUserId: z.string().min(1),
    moduleEntityType: z.string().min(1),
    moduleEntityId: z.string().min(1),
    bankAccountId: z.string().min(1).nullable().default(null),
    currency: z.literal("NGN").default("NGN"),
    cashAmount: kobo.default(0n),
    revenueAmount: kobo.default(0n),
    depositDelta: kobo.default(0n),
    principalAmount: kobo.default(0n),
    interestAmount: kobo.default(0n),
    retentionAmount: kobo.default(0n),
    uniquenessKey: z.string().min(1).max(300),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((event, ctx) => {
    if (RESERVED_EVENT_TYPES.includes(event.eventType)) {
      ctx.addIssue({ code: "custom", message: `${event.eventType} is reserved in Phase 1` });
    }
    if (RESERVED_SOURCES.includes(event.source)) {
      ctx.addIssue({ code: "custom", message: `${event.source} is reserved in Phase 1` });
    }
    for (const field of MONEY_FIELDS) {
      if (event[field] < 0n) {
        ctx.addIssue({ code: "custom", path: [field], message: "Original events carry positive amounts" });
      }
    }
    if (STATUS_EVENT_TYPES.includes(event.eventType) && MONEY_FIELDS.some((f) => event[f] !== 0n)) {
      ctx.addIssue({ code: "custom", message: `${event.eventType} is a status event: money fields must be zero` });
    }
    if (event.eventType === "INTEREST_INCOME" && event.revenueAmount !== event.interestAmount) {
      ctx.addIssue({ code: "custom", message: "INTEREST_INCOME revenue must equal interest" });
    }
    if (event.eventType === "PRINCIPAL_RECOVERY" && event.revenueAmount !== 0n) {
      ctx.addIssue({ code: "custom", message: "PRINCIPAL_RECOVERY is never revenue" });
    }
  });

export type NewLedgerEvent = z.input<typeof newLedgerEventSchema>;
export type ValidLedgerEvent = z.output<typeof newLedgerEventSchema>;

/** Money fields of a reversal: the exact negatives of the original. */
export function negatedAmounts(original: Record<MoneyField, bigint>): Record<MoneyField, bigint> {
  return Object.fromEntries(MONEY_FIELDS.map((f) => [f, -original[f]])) as Record<MoneyField, bigint>;
}
