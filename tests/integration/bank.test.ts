/**
 * Bank accounts and statements, Track B (PRD F10) against the test database:
 * go-live opening balances, statement import through a saved column mapping,
 * continuity and overlapping statements.
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { LocalEvidenceStore } from "@/evidence/store";
import { createBankAccount } from "@/modules/credit/banking/bank-accounts";
import { BankError, commitOpeningBalance, importStatement, rejectOpeningBalance, saveMapping, uploadOpeningBalance } from "@/modules/credit/banking/statements";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(240_000);

const pdf = () => ({ filename: "statement.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]) });
const csv = (lines: string[]) => ({ filename: `statement-${randomUUID()}.csv`, bytes: new TextEncoder().encode(lines.join("\r\n")) });

describeDb("bank statements (F10)", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const admin = { id: `admin-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const finance = { id: `fm-${randomUUID()}`, ipAddress: "127.0.0.1" };

  async function account() {
    return createBankAccount(db, admin, { bankName: "Test Bank", branch: "", accountName: "MOAUM", accountNumber: String(randomInt(1e9, 9.99e9)).slice(0, 10) });
  }

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
    dir = await mkdtemp(path.join(tmpdir(), "bank-"));
    store = new LocalEvidenceStore(dir, "test-secret");
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("takes a go-live opening balance from Admin and posts it only when someone else commits it", async () => {
    const acc = await account();
    const first = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "1,000,000.00" }, pdf());
    await expect(uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "5" }, pdf())).rejects.toThrow(/already has an opening balance/);
    await expect(commitOpeningBalance(db, admin, first.id)).rejects.toThrow(/Someone other than the uploader/);
    await rejectOpeningBalance(db, finance, first.id, "Wrong statement attached");

    const opening = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "1,200,000.00" }, pdf());
    await commitOpeningBalance(db, finance, opening.id);
    const event = await db.ledgerEvent.findFirstOrThrow({ where: { moduleEntityType: "BankAccount", moduleEntityId: acc.id, eventType: "OPENING_BALANCE" } });
    expect(event).toMatchObject({ cashAmount: 120_000_000n, bankAccountId: acc.id, source: "LEGACY_IMPORT", portalUserId: finance.id });
    await expect(commitOpeningBalance(db, finance, opening.id)).rejects.toThrow(/already been decided/);
  });

  it("imports statements through the account's column mapping, checks continuity, and skips lines it already has", async () => {
    const acc = await account();
    await expect(importStatement(db, store, finance, { bankAccountId: acc.id, periodFrom: "2026-01-01", periodTo: "2026-01-31", openingBalance: "0", closingBalance: "0" }, csv(["x"]))).rejects.toThrow(
      /Commit this account's go-live opening balance/,
    );
    const opening = await uploadOpeningBalance(db, store, admin, { bankAccountId: acc.id, asOf: "2025-12-31", amount: "500,000" }, pdf());
    await commitOpeningBalance(db, finance, opening.id);

    // The bank's own export: a title line, its own headers, day-first dates.
    await saveMapping(db, finance, acc.id, {
      fields: { transaction_date: "Trans Date", narration: "Narration", reference: "Ref", debit: "Withdrawals", credit: "Lodgements", balance: "Balance" },
      dateFormat: "DMY",
    });
    const header = "Trans Date,Ref,Narration,Withdrawals,Lodgements,Balance";
    const jan = csv([
      "TEST BANK STATEMENT JANUARY 2026",
      header,
      "02/01/2026,TRF001,PAYROLL OCT,,77500.00,577500.00",
      "15/01/2026,CHG,SMS ALERT CHARGES,52.50,,577447.50",
      "28/01/2026,TRF002,TRANSFER FROM ADA OKEKE,,20000.00,597447.50",
    ]);
    const input = { bankAccountId: acc.id, periodFrom: "2026-01-01", periodTo: "2026-01-31", openingBalance: "500,000.00", closingBalance: "597,447.50" };

    await expect(importStatement(db, store, finance, { ...input, openingBalance: "499,000", closingBalance: "596,447.50" }, jan)).rejects.toThrow(/doesn't continue the go-live opening balance of ₦500,000.00/);
    await expect(importStatement(db, store, finance, { ...input, closingBalance: "600,000" }, jan)).rejects.toMatchObject({ details: [expect.stringMatching(/not the closing balance/)] });
    await expect(importStatement(db, store, finance, input, csv([header, "02/13/2026,X,Y,,1.00,"]))).rejects.toBeInstanceOf(BankError);

    const first = await importStatement(db, store, finance, input, jan);
    expect(first).toMatchObject({ lineCount: 3, skippedCount: 0 });
    const lines = await db.bankStatementLine.findMany({ where: { statementId: first.id }, orderBy: { transactionDate: "asc" } });
    expect(lines.map((l) => [l.transactionDate.toISOString().slice(0, 10), l.direction, l.amount])).toEqual([
      ["2026-01-02", "CREDIT", 7_750_000n],
      ["2026-01-15", "DEBIT", 5_250n],
      ["2026-01-28", "CREDIT", 2_000_000n],
    ]);

    // February continues January; the overlapping 28 January line is not duplicated.
    const feb = csv([header, "28/01/2026,TRF002,TRANSFER FROM ADA OKEKE,,20000.00,597447.50", "03-Feb-2026,TRF003,PAYROLL NOV,,80000.00,677447.50"]);
    await expect(importStatement(db, store, finance, { ...input, periodFrom: "2026-01-28", periodTo: "2026-02-28", openingBalance: "500,000", closingBalance: "600,000" }, feb)).rejects.toThrow(
      /doesn't continue the previous statement's closing balance/,
    );
    const second = await importStatement(
      db,
      store,
      finance,
      { ...input, periodFrom: "2026-01-28", periodTo: "2026-02-28", openingBalance: "577,447.50", closingBalance: "677,447.50" },
      feb,
    );
    expect(second).toMatchObject({ lineCount: 1, skippedCount: 1 });
    expect(await db.bankStatementLine.count({ where: { bankAccountId: acc.id } })).toBe(4);
  });
});
