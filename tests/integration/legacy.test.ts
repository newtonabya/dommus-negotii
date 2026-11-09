/**
 * Legacy loan import (PRD F8) against the test database: MOAUM's own layout
 * (Name, PIN, Tenure, Principal), dry run, dual control, the go-live gate,
 * one OPENING_BALANCE per loan and AT-b. Runs in a far-future year of its own
 * (settings and ledger rows can't be deleted).
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { localDate } from "@/lib/dates";
import { kobo } from "@/lib/money";
import { LocalEvidenceStore } from "@/evidence/store";
import { computeLoanState } from "@/modules/credit/domain/recompute";
import { loanTerms } from "@/modules/credit/loans/common";
import { commitLegacyImport, loadLegacyBatch, previewLegacyImport } from "@/modules/credit/loans/legacy-import";
import { ledgerPrincipalOutstanding } from "@/modules/credit/loans/queries";
import { placeholderEmail } from "@/modules/credit/members/rules";
import { approveChange, proposeChange } from "@/shell/settings/settings";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(240_000);

describeDb("legacy loan import (F8)", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const admin = { id: `admin-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const finance = { id: `fm-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const management = { id: `mgmt-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const year = randomInt(2300, 2900);
  const goLive = localDate(`${year}-03-31`);
  const later = localDate(`${year}-04-02`);

  async function member(fullName: string, pin: string) {
    const userId = randomBytes(16).toString("hex");
    const phone = `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
    await db.user.create({ data: { id: userId, name: fullName, email: placeholderEmail(phone), phoneNumber: phone } });
    return db.member.create({
      data: { userId, fullName, phone, address: "Makurdi", moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`, nextOfKinName: "K", nextOfKinPhone: "+2347010000000", status: "ACTIVE", payrollStaffNo: pin },
    });
  }
  const file = (rows: string[]) => ({ filename: `loan-records-${randomUUID()}.csv`, bytes: new TextEncoder().encode(["SN,Name,PIN,Department,Tenure,Principal,rate_monthly_percent", ...rows].join("\n")) });

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
    dir = await mkdtemp(path.join(tmpdir(), "legacy-"));
    store = new LocalEvidenceStore(dir, "test-secret");
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("[AT-b] brings in loans from MOAUM's list with one opening balance each and runs them from go-live", async () => {
    const pinA = `A${randomInt(10_000, 99_999)}`;
    const pinB = `ST${randomInt(1_000, 9_999)}`;
    const a = await member("Daniel Akaa", pinA);
    const b = await member("Joy Ameh", pinB);

    const rows = [`1,Daniel Akaa,${pinA},,6,60000,7.5`, `2,Joi ameh,${pinB},,2,166666.6666666667,0`];
    const input = { goLiveDate: goLive, controlTotal: "226,666.67", rowCount: "2" };

    // Control total and unknown PIN are refused.
    const bad = await previewLegacyImport(db, store, admin, { ...input, controlTotal: "200000" }, file([...rows]));
    expect(bad.ok).toBe(false);
    expect((await loadLegacyBatch(db, bad.batchId))?.stored.batchErrors).toEqual([expect.stringMatching(/control total is ₦200,000.00/)]);
    const unknown = await previewLegacyImport(db, store, admin, { ...input, controlTotal: "1000", rowCount: "1" }, file([`1,Nobody,S0000${randomInt(10, 99)}X,,2,1000,`]));
    expect((await loadLegacyBatch(db, unknown.batchId))?.rows[0]?.errors).toEqual([expect.stringMatching(/no member has this payroll staff number/)]);

    const preview = await previewLegacyImport(db, store, admin, input, file(rows));
    expect(preview.ok).toBe(true);
    const shown = await loadLegacyBatch(db, preview.batchId);
    const [rowA, rowB] = shown!.rows.map((r) => r.plan!);
    expect(rowA).toMatchObject({ memberId: a.id, outstanding: "6000000", tenure: 6, rateBps: 750, firstInstallment: "1450000", firstDueDate: `${year}-04-30` });
    expect(rowB).toMatchObject({ memberId: b.id, outstanding: "16666667", rateBps: 0 });
    expect(rowB!.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/rounded to the kobo/), expect.stringMatching(/differs from the member record/)]));

    // Not without the go-live date setting, and not by the uploader.
    await expect(commitLegacyImport(db, finance, preview.batchId, later)).rejects.toThrow(/go-live date isn't set yet|go-live date setting is/);
    const request = await proposeChange(db, admin, { key: "go_live_date", value: goLive, effectiveFrom: goLive, reason: "Cutover agreed by the board" }, localDate(`${year}-03-01`));
    await approveChange(db, management, request.id, "", localDate(`${year}-03-01`));
    await expect(commitLegacyImport(db, admin, preview.batchId, later)).rejects.toThrow(/Someone other than the uploader/);

    const result = await commitLegacyImport(db, finance, preview.batchId, later);
    expect(result.loans).toBe(2);
    await expect(commitLegacyImport(db, finance, preview.batchId, later)).rejects.toThrow(/already committed/);

    const loan = await db.loan.findFirstOrThrow({ where: { memberId: a.id } });
    expect(loan).toMatchObject({ status: "ACTIVE", legacyAccountNo: `LEGACY-${pinA}`, rateBps: 750, tenureApproved: 6 });
    expect(loan.loanAccountNo).toMatch(new RegExp(`^CSS-${year}-\\d{5}$`));
    expect(loan.d0?.toISOString().slice(0, 10)).toBe(goLive);
    const events = await db.ledgerEvent.findMany({ where: { moduleEntityType: "Loan", moduleEntityId: loan.id } });
    expect(events.map((e) => e.eventType)).toEqual(["OPENING_BALANCE"]);
    expect(events[0]).toMatchObject({ source: "LEGACY_IMPORT", principalAmount: 6_000_000n, cashAmount: 0n, revenueAmount: 0n });
    expect((await ledgerPrincipalOutstanding(db, [loan.id])).get(loan.id)).toBe(6_000_000n);

    // AT-b: the next remittance (₦14,500 on the first due date) is 4,500 interest + 10,000 principal.
    const state = computeLoanState(loanTerms(loan), [{ id: "next", date: localDate(`${year}-04-30`), amount: kobo(1_450_000n), order: "1" }], localDate(`${year}-04-30`));
    expect(state.allocations.map((x) => [x.kind, x.amount])).toEqual([
      ["INTEREST", 450_000n],
      ["PRINCIPAL", 1_000_000n],
    ]);
    expect(state.outstandingPrincipal).toBe(5_000_000n);
  });
});
