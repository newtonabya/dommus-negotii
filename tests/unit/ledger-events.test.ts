import type { LedgerEvent } from "@/generated/prisma/client";
import { newLedgerEventSchema, type NewLedgerEvent } from "@/ledger/events";
import { buildReversal, LedgerError } from "@/ledger/post";

const EVIDENCE = "8d3c2f9e-6f1a-4b7e-9a51-2c4d6e8f0a1b";

const base: NewLedgerEvent = {
  occurredAt: new Date("2026-04-01"),
  moduleCode: "CREDIT",
  eventType: "INTEREST_INCOME",
  source: "REMITTANCE_SCHEDULE",
  evidenceRefs: [EVIDENCE],
  portalUserId: "user-treasurer",
  moduleEntityType: "Loan",
  moduleEntityId: "loan-1",
  interestAmount: 750_000n,
  revenueAmount: 750_000n,
  uniquenessKey: "CREDIT:ROW:s1:1:INTEREST:0",
};

const issues = (input: NewLedgerEvent) => {
  const result = newLedgerEventSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("ledger event rules (PRD F4)", () => {
  it("accepts a valid INTEREST_INCOME event and fills defaults", () => {
    const parsed = newLedgerEventSchema.parse(base);
    expect(parsed.currency).toBe("NGN");
    expect(parsed.cashAmount).toBe(0n);
  });

  it("requires at least one evidence reference", () => {
    expect(issues({ ...base, evidenceRefs: [] })).toContain("Every ledger event needs evidence");
  });

  it("never counts principal recovery as revenue", () => {
    expect(
      issues({ ...base, eventType: "PRINCIPAL_RECOVERY", interestAmount: 0n, principalAmount: 1n, revenueAmount: 1n }),
    ).toContain("PRINCIPAL_RECOVERY is never revenue");
  });

  it("makes interest income revenue in full", () => {
    expect(issues({ ...base, revenueAmount: 1n })).toContain("INTEREST_INCOME revenue must equal interest");
  });

  it("rejects negative amounts on original events", () => {
    expect(issues({ ...base, interestAmount: -1n, revenueAmount: -1n })).toContain(
      "Original events carry positive amounts",
    );
  });

  it("keeps money out of status events", () => {
    expect(issues({ ...base, eventType: "SCHEDULE_POSTED", interestAmount: 0n, revenueAmount: 0n })).toEqual([]);
    expect(issues({ ...base, eventType: "SCHEDULE_POSTED" })).toContain(
      "SCHEDULE_POSTED is a status event: money fields must be zero",
    );
  });

  it("rejects reserved types and sources", () => {
    expect(issues({ ...base, source: "LIVE_PAYMENT" })).toContain("LIVE_PAYMENT is reserved in Phase 1");
    expect(issues({ ...base, eventType: "BANK_DEPOSIT", interestAmount: 0n, revenueAmount: 0n })).toContain(
      "BANK_DEPOSIT is reserved in Phase 1",
    );
  });
});

describe("buildReversal", () => {
  const original: LedgerEvent = {
    id: "0b5f3c1e-2a4d-4e6f-8a9b-1c2d3e4f5a6b",
    occurredAt: new Date("2026-04-01"),
    postedAt: new Date("2026-04-02T09:00:00Z"),
    moduleCode: "CREDIT",
    eventType: "INTEREST_INCOME",
    source: "REMITTANCE_SCHEDULE",
    evidenceRefs: [EVIDENCE],
    portalUserId: "user-treasurer",
    moduleEntityType: "Loan",
    moduleEntityId: "loan-1",
    bankAccountId: null,
    currency: "NGN",
    cashAmount: 0n,
    revenueAmount: 37_500n,
    depositDelta: 0n,
    principalAmount: 0n,
    interestAmount: 37_500n,
    retentionAmount: 0n,
    status: "POSTED",
    uniquenessKey: "k1",
    reversesEventId: null,
    schemaVersion: 2,
    metadata: {},
  };
  const input = {
    uniquenessKey: "k1:REV",
    occurredAt: new Date("2026-05-10"),
    portalUserId: "user-system",
    evidenceRefs: [EVIDENCE],
    reason: "Recompute after backdated catch-up",
  };

  it("exactly negates the original and links to it", () => {
    const reversal = buildReversal(original, input);
    expect(reversal.interestAmount).toBe(-37_500n);
    expect(reversal.revenueAmount).toBe(-37_500n);
    expect(reversal.cashAmount).toBe(-0n);
    expect(reversal.reversesEventId).toBe(original.id);
    expect(reversal.eventType).toBe("INTEREST_INCOME");
  });

  it("refuses to reverse a reversal, or reverse without reason or evidence", () => {
    expect(() => buildReversal({ ...original, reversesEventId: "x" }, input)).toThrow(LedgerError);
    expect(() => buildReversal(original, { ...input, reason: " " })).toThrow(LedgerError);
    expect(() => buildReversal(original, { ...input, evidenceRefs: [] })).toThrow(LedgerError);
  });
});
