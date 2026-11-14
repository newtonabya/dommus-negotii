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
import { missingForLoan } from "@/modules/credit/loans/applications";
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
    // Wide ranges: the test database keeps every earlier run's members, so short PINs eventually repeat.
    const pinA = `A${randomInt(1e9, 9e9)}`;
    const pinB = `ST${randomInt(1e9, 9e9)}`;
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

  it("creates the members a file names on the chosen payroll: next MOAUM numbers, PIN as staff number, a set-up link each", async () => {
    const source = await db.remittanceSource.create({ data: { code: `LEG-${randomInt(1e5, 9e5)}`, name: "Legacy payroll", createdById: "test" } });
    const local = () => `080${String(randomInt(0, 1e8)).padStart(8, "0")}`;
    const [phoneA, phoneB] = [local(), local()];
    const [pinA, pinB, pinOld] = [`A${randomInt(1e9, 9e9)}`, `ST${randomInt(1e9, 9e9)}`, `S${randomInt(1e9, 9e9)}`];
    const old = await member("Already Here", pinOld);
    await db.member.update({ where: { id: old.id }, data: { remittanceSourceId: source.id } });
    const sheet = (rows: string[]) => ({ filename: `legacy-${randomUUID()}.csv`, bytes: new TextEncoder().encode(["SN,Name,PIN,Department,Tenure,Principal,Phone", ...rows].join("\n")) });
    const input = { goLiveDate: goLive, controlTotal: "423,333.34", rowCount: "3", remittanceSource: source.id };
    const rows = (a: string, b: string) => [`1,Aondo Tersoo,${pinA},Bursary,2,166666.67,${a}`, `2,Ihuoma Okafor,${pinB},,2,166666.67,${b}`, `3,Already Here,${pinOld},,3,90000,`];

    // A member the file must create needs a phone; one phone can't serve two people.
    const noPhone = await previewLegacyImport(db, store, admin, input, sheet(rows(phoneA, "")));
    expect(noPhone.ok).toBe(false);
    expect((await loadLegacyBatch(db, noPhone.batchId))?.rows[1]?.errors.join(" ")).toMatch(/Phone: enter a Nigerian mobile number for Ihuoma Okafor/);
    const samePhone = await previewLegacyImport(db, store, admin, input, sheet(rows(phoneA, phoneA)));
    expect((await loadLegacyBatch(db, samePhone.batchId))?.rows[1]?.errors.join(" ")).toMatch(/also given for PIN/);

    const preview = await previewLegacyImport(db, store, admin, input, sheet(rows(phoneA, phoneB)));
    expect(preview.ok).toBe(true);
    const shown = await loadLegacyBatch(db, preview.batchId);
    expect(shown?.rows[0]?.plan?.newMember).toEqual({ phone: `+234${phoneA.slice(1)}`, department: "Bursary" });
    expect(shown?.rows[2]?.plan).toMatchObject({ memberId: old.id, newMember: null });
    // Nothing exists until the Finance Manager brings it in.
    expect(await db.member.count({ where: { remittanceSourceId: source.id } })).toBe(1);

    const result = await commitLegacyImport(db, finance, preview.batchId, later);
    expect(result).toMatchObject({ loans: 3, membersCreated: 2, smsFailed: 0 });
    const a = await db.member.findFirstOrThrow({ where: { remittanceSourceId: source.id, payrollStaffNo: pinA }, include: { user: { include: { accounts: true } }, invitation: true, loans: true } });
    const b = await db.member.findFirstOrThrow({ where: { remittanceSourceId: source.id, payrollStaffNo: pinB } });
    expect(a).toMatchObject({ fullName: "Aondo Tersoo", status: "ACTIVE", phone: `+234${phoneA.slice(1)}`, department: "Bursary", address: "", idScanEvidenceId: null });
    expect(a.memberNo).toMatch(/^MOAUM\/\d{4,}$/);
    // File order: the second row's number comes after the first's.
    expect(Number(b.memberNo.slice(6))).toBeGreaterThan(Number(a.memberNo.slice(6)));
    // A login with the phone as username, no password yet, and an ACTIVATION link to set one.
    expect(a.user).toMatchObject({ phoneNumber: `+234${phoneA.slice(1)}`, phoneNumberVerified: false });
    expect(a.user.accounts).toHaveLength(0);
    expect(a.invitation).toMatchObject({ type: "ACTIVATION", phone: `+234${phoneA.slice(1)}` });
    expect(a.loans).toHaveLength(1);
    expect(a.loans[0]).toMatchObject({ status: "ACTIVE", amountApproved: 16_666_667n, tenureApproved: 2 });
    expect(await db.loan.count({ where: { memberId: old.id, status: "ACTIVE" } })).toBe(1);
    // Until they complete their details they cannot apply for a first loan.
    expect(missingForLoan(a)).toEqual(["home address", "next of kin's name", "next of kin's phone", "ID card scan"]);
  });
});
