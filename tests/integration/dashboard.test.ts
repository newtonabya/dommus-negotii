/**
 * GMD dashboard (PRD F14) against the test database: revenue is interest
 * income only (AT-j), bank interest is shown apart, and every figure drills
 * down to its transactions. Uses a far-future month of its own, since test
 * rows can't be deleted.
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { localDate } from "@/lib/dates";
import { postEvent, reverseEvent } from "@/ledger/post";
import { drillDown, gmdDashboard, monthRange, monthsBack } from "@/modules/credit/reports/dashboard";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(180_000);

describe("monthsBack", () => {
  it("lists the last months oldest first, across a year end", () => {
    expect(monthsBack(localDate("2027-02-10"), 4)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describeDb("GMD dashboard (F14)", () => {
  let db: PrismaClient;
  const actor = `gmd-test-${randomUUID()}`;

  beforeAll(async () => {
    db = createClient(url as string);
    for (let attempt = 1; ; attempt++) {
      try {
        await db.$queryRaw`SELECT 1`;
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("[AT-j] counts only recognised revenue, net of reversals, and shows bank interest as other bank credits", async () => {
    const year = randomInt(2300, 2900);
    const month = `${year}-05`;
    const on = new Date(`${month}-10T00:00:00Z`);
    const evidence = [randomUUID()];
    const loan = randomUUID();
    const account = randomUUID();
    const base = { occurredAt: on, moduleCode: "CREDIT", evidenceRefs: evidence, portalUserId: actor, metadata: {} } as const;
    const key = (k: string) => `TEST:DASH:${year}:${randomUUID()}:${k}`;
    // The year is random but may repeat an earlier run's: compare before and after.
    const range0 = monthRange(month);
    const sum = (rows: Array<{ revenueAmount: bigint; cashAmount: bigint }>, f: "revenueAmount" | "cashAmount") => rows.reduce((t, e) => t + e[f], 0n);
    const revenueBefore = sum(await drillDown(db, { type: "REVENUE", ...range0 }), "revenueAmount");
    const interestBefore = sum(await drillDown(db, { type: "BANK_INTEREST", ...range0 }), "cashAmount");

    await postEvent(db, { ...base, eventType: "PRINCIPAL_RECOVERY", source: "REMITTANCE_SCHEDULE", moduleEntityType: "Loan", moduleEntityId: loan, principalAmount: 5_000_000n, uniquenessKey: key("p") });
    const interest = await postEvent(db, { ...base, eventType: "INTEREST_INCOME", source: "REMITTANCE_SCHEDULE", moduleEntityType: "Loan", moduleEntityId: loan, interestAmount: 600_000n, revenueAmount: 600_000n, uniquenessKey: key("i") });
    await postEvent(db, { ...base, eventType: "INTEREST_INCOME", source: "REMITTANCE_SCHEDULE", moduleEntityType: "Loan", moduleEntityId: loan, interestAmount: 150_000n, revenueAmount: 150_000n, uniquenessKey: key("i2") });
    await postEvent(db, { ...base, eventType: "OPENING_BALANCE", source: "LEGACY_IMPORT", moduleEntityType: "BankAccount", moduleEntityId: account, cashAmount: 90_000_000n, uniquenessKey: key("o") });
    await postEvent(db, { ...base, eventType: "DEPOSIT_CREDITED", source: "REMITTANCE_SCHEDULE", moduleEntityType: "Member", moduleEntityId: randomUUID(), depositDelta: 250_000n, uniquenessKey: key("d") });
    await postEvent(db, { ...base, eventType: "CASH_IN", source: "BANK_STATEMENT", moduleEntityType: "BankLineEntry", moduleEntityId: randomUUID(), cashAmount: 12_345n, uniquenessKey: key("b"), metadata: { category: "BANK_INTEREST" } });
    // A recompute reversed part of the interest: revenue is net of it.
    await reverseEvent(db, interest.event.id, { uniquenessKey: key("r"), occurredAt: on, portalUserId: actor, evidenceRefs: evidence, reason: "test recompute" });

    const { from, to } = monthRange(month);
    const revenue = await drillDown(db, { type: "REVENUE", from, to });
    expect(revenue.every((e) => e.eventType === "INTEREST_INCOME")).toBe(true);
    expect(sum(revenue, "revenueAmount") - revenueBefore).toBe(150_000n);

    const dashboard = await gmdDashboard(db, localDate(`${month}-31`));
    expect(dashboard.revenue.months.at(-1)).toEqual({ month, amount: revenueBefore + 150_000n });
    expect(dashboard.revenue.otherBankCredits.at(-1)).toEqual({ month, amount: interestBefore + 12_345n });
    expect(dashboard.cash.otherBankCreditsMonth).toBe(interestBefore + 12_345n);
    const bankInterest = await drillDown(db, { type: "BANK_INTEREST", from, to });
    expect(sum(bankInterest, "cashAmount") - interestBefore).toBe(12_345n);
  });
});
