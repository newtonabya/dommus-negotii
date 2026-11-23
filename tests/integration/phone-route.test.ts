/**
 * Messages meant for a phone while SMS is switched off: they go to the email
 * on record for that number, or nowhere. Skipped when TEST_DATABASE_URL is not set.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { routeToPhone } from "@/shell/notifications/phone-route";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

const phone = () => `+23484${String(randomInt(0, 1e8)).padStart(8, "0")}`;

describeDb("phone messages while SMS is off", () => {
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

  it("goes by SMS while SMS is on, even when there is an email", async () => {
    const ph = phone();
    await db.user.create({ data: { id: `u-${randomUUID()}`, name: "Test", email: `r-${randomUUID()}@example.com`, phoneNumber: ph } });
    expect(await routeToPhone(db, ph, true)).toEqual({ channel: "SMS", recipient: ph });
  });

  it("goes to the email on record while SMS is off, or nowhere", async () => {
    const withEmail = phone();
    const email = `r-${randomUUID()}@example.com`;
    await db.user.create({ data: { id: `u-${randomUUID()}`, name: "Test", email, phoneNumber: withEmail } });
    expect(await routeToPhone(db, withEmail, false)).toEqual({ channel: "EMAIL", recipient: email });

    const placeholder = phone();
    await db.user.create({ data: { id: `u-${randomUUID()}`, name: "Test", email: `${randomUUID()}@members.dommus.invalid`, phoneNumber: placeholder } });
    expect(await routeToPhone(db, placeholder, false)).toBeNull();
    expect(await routeToPhone(db, phone(), false)).toBeNull();
  });
});
