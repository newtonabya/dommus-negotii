/**
 * Settings with Management approval against the test database (PRD F2, AT-r).
 * The setting table is append-only, so every run works on its own random dates
 * centuries ahead: test rows never change today's values. Skipped when
 * TEST_DATABASE_URL is not set.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { addDays, localDate } from "@/lib/dates";
import {
  approveChange,
  changeSetting,
  getCountSetting,
  getRateSetting,
  proposeChange,
  rejectChange,
  SettingsError,
  withdrawChange,
} from "@/shell/settings/settings";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

describeDb("settings with approval", () => {
  let db: PrismaClient;
  const admin = { id: `admin-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const management = { id: `mgmt-${randomUUID()}`, ipAddress: "127.0.0.1" };
  // A private "today" for this run, somewhere in the years 2400-2900.
  const today = addDays(localDate("2400-01-01"), randomInt(0, 180_000));
  const day = (n: number) => addDays(today, n);

  /** A rate (as typed) that differs from the one in force on `on`. */
  async function differentRate(on: string): Promise<string> {
    const current = await getRateSetting(db, "interest_rate_bps", localDate(on));
    let next = BigInt(randomInt(100, 4900));
    if (next === current) next += 1n;
    return `${next / 100n}.${(next % 100n).toString().padStart(2, "0")}`;
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
    // A run that died half-way may have left a proposal open; only one may be open per setting.
    await db.settingChangeRequest.updateMany({ where: { status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("has no effect until Management approves, then applies from the effective date (AT-r)", async () => {
    const before = await getRateSetting(db, "interest_rate_bps", day(10));
    const value = await differentRate(day(10));
    const request = await proposeChange(db, admin, { key: "interest_rate_bps", value, effectiveFrom: day(10), reason: "Board resolution 12/2026" }, today);

    expect(await getRateSetting(db, "interest_rate_bps", day(10))).toBe(before);

    await expect(approveChange(db, admin, request.id, "", today)).rejects.toThrow(/your own proposal/);
    await approveChange(db, management, request.id, "Approved at the board meeting", today);

    const approved = await getRateSetting(db, "interest_rate_bps", day(10));
    expect(approved).not.toBe(before);
    expect(approved.toString()).toBe(value.replace(".", "").replace(/^0+/, ""));
    expect(await getRateSetting(db, "interest_rate_bps", day(9))).toBe(before);

    const audit = await db.auditLog.findFirst({ where: { action: "setting.change_approved", entityId: request.id } });
    expect(audit?.userId).toBe(management.id);
    await expect(approveChange(db, management, request.id, "", today)).rejects.toThrow(/already approved/);
  });

  it("rejects a backdated effective date, at proposal and at approval (AT-r)", async () => {
    const value = await differentRate(day(1));
    await expect(
      proposeChange(db, admin, { key: "interest_rate_bps", value, effectiveFrom: day(-1), reason: "Backdated on purpose" }, today),
    ).rejects.toThrow(/can't be in the past/);

    const request = await proposeChange(db, admin, { key: "interest_rate_bps", value, effectiveFrom: day(1), reason: "Decided late" }, today);
    // Management only gets to it after the date has passed.
    await expect(approveChange(db, management, request.id, "", day(2))).rejects.toThrow(/has passed/);
    await rejectChange(db, management, request.id, "Too late, propose again");
    expect((await db.settingChangeRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("REJECTED");
  });

  it("allows one open proposal per setting, withdrawn only by its proposer", async () => {
    const effectiveFrom = day(20);
    const first = await proposeChange(db, admin, { key: "max_open_loans_per_member", value: String(randomInt(3, 10)), effectiveFrom, reason: "First proposal here" }, today);
    await expect(
      proposeChange(db, admin, { key: "max_open_loans_per_member", value: "1", effectiveFrom, reason: "Second proposal here" }, today),
    ).rejects.toThrow(/already has a proposal/);
    await expect(withdrawChange(db, management, first.id)).rejects.toThrow(/Only the person/);
    await withdrawChange(db, admin, first.id);
    await expect(rejectChange(db, management, first.id, "too late now")).rejects.toThrow(/already withdrawn/);
  });

  it("changes operational settings at once, and refuses financial ones without approval", async () => {
    const before = await getCountSetting(db, "invitation_ttl_days", today);
    const next = before === 30 ? 29 : before + 1;
    await changeSetting(db, admin, "invitation_ttl_days", String(next), today);
    expect(await getCountSetting(db, "invitation_ttl_days", today)).toBe(next);
    expect(await getCountSetting(db, "invitation_ttl_days", day(-1))).toBe(before);
    await expect(changeSetting(db, admin, "invitation_ttl_days", String(next), today)).rejects.toThrow(/already/);
    await expect(changeSetting(db, admin, "interest_rate_bps", "9", today)).rejects.toThrow(SettingsError);
    await expect(changeSetting(db, admin, "invitation_ttl_days", "0", today)).rejects.toThrow(/between 1 and 30/);
  });
});
