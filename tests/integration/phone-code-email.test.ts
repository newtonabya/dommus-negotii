/**
 * Where phone codes and phone-number password resets go while SMS is
 * switched off. Skipped when TEST_DATABASE_URL is not set.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { emailForPhone, phoneResetRoute } from "@/shell/auth/reset-by-phone";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

const phone = () => `+23482${String(randomInt(0, 1e8)).padStart(8, "0")}`;

describeDb("phone codes by email while SMS is off", () => {
  let db: PrismaClient;

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
  afterAll(async () => db?.$disconnect());

  async function user(ph: string, email: string, deactivated = false) {
    const id = `u-${randomUUID()}`;
    await db.user.create({ data: { id, name: "Test", email, phoneNumber: ph, deactivatedAt: deactivated ? new Date() : null } });
    return id;
  }
  async function member(ph: string, userId: string, email: string | null) {
    const no = `T-${randomUUID()}`;
    await db.member.create({ data: { memberNo: no, moaumIdNumber: no, userId, fullName: "Test", phone: ph, email, address: "", nextOfKinName: "", nextOfKinPhone: "" } });
  }
  async function invitation(ph: string, email: string | null, opts: { expired?: boolean; used?: boolean } = {}) {
    await db.invitation.create({
      data: {
        fullName: "Test",
        phone: ph,
        email,
        tokenHash: sha256Hex(randomUUID()),
        sentById: "test",
        expiresAt: new Date(Date.now() + (opts.expired ? -1 : 1) * 86_400_000),
        registeredAt: opts.used ? new Date() : null,
      },
    });
  }

  it("uses the login's real email first", async () => {
    const ph = phone();
    const id = await user(ph, `real-${randomUUID()}@example.com`);
    await member(ph, id, "other@example.com");
    expect(await emailForPhone(db, ph)).toMatch(/^real-.*@example\.com$/);
  });

  it("falls back to the member record's email when the login has a placeholder", async () => {
    const ph = phone();
    const id = await user(ph, `${randomUUID()}@members.dommus.invalid`);
    await member(ph, id, "member@example.com");
    expect(await emailForPhone(db, ph)).toBe("member@example.com");
  });

  it("uses an open invitation's email before anyone has a login, but not an expired or used one", async () => {
    const ph = phone();
    await invitation(ph, "old@example.com", { expired: true });
    await invitation(ph, "used@example.com", { used: true });
    expect(await emailForPhone(db, ph)).toBeNull();
    await invitation(ph, "invited@example.com");
    expect(await emailForPhone(db, ph)).toBe("invited@example.com");
  });

  it("gives nothing for a switched-off login or a number with no email anywhere", async () => {
    const off = phone();
    await user(off, "off@example.com", true);
    expect(await emailForPhone(db, off)).toBeNull();
    const none = phone();
    const id = await user(none, `${randomUUID()}@members.dommus.invalid`);
    await member(none, id, null);
    expect(await emailForPhone(db, none)).toBeNull();
    expect(await emailForPhone(db, phone())).toBeNull();
  });

  it("routes a phone-number password reset by SMS, by email, or nowhere", async () => {
    const ph = phone();
    expect(await phoneResetRoute(db, ph, true)).toEqual({ route: "sms" });
    expect(await phoneResetRoute(db, ph, false)).toEqual({ route: "none" });
    const email = `reset-${randomUUID()}@example.com`;
    await user(ph, email);
    expect(await phoneResetRoute(db, ph, false)).toEqual({ route: "email", email });
    const placeholder = phone();
    await user(placeholder, `${randomUUID()}@members.dommus.invalid`);
    expect(await phoneResetRoute(db, placeholder, false)).toEqual({ route: "none" });
  });
});
