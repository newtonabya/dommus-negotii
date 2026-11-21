/**
 * How a member's one-time code is sent: saved preference, the one-off switch on
 * the code screen, and email-only while SMS is off. Skipped when
 * TEST_DATABASE_URL is not set.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { codeChoices, codeDestination, describeDestination, maskEmail, setNextCodeChannel, takeNextCodeChannel } from "@/shell/auth/code-channel";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

const phone = () => `+23483${String(randomInt(0, 1e8)).padStart(8, "0")}`;

describeDb("one-time code channel", () => {
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

  /** A login; `email: false` gives it the members' placeholder address. Emails are unique and test rows stay, so each is fresh. */
  async function login(opts: { email?: boolean; prefers?: "SMS" | "EMAIL" | null } = {}) {
    const ph = phone();
    const email = opts.email === false ? `${randomUUID()}@members.dommus.invalid` : `m-${randomUUID()}@example.com`;
    await db.user.create({ data: { id: `u-${randomUUID()}`, name: "Test", email, phoneNumber: ph, preferredChannel: opts.prefers ?? null } });
    return { ph, email };
  }

  it("follows the saved preference while SMS is on, defaulting to SMS", async () => {
    const plain = await login();
    expect(await codeDestination(db, plain.ph, { smsEnabled: true })).toEqual({ channel: "SMS", to: plain.ph });
    const prefersEmail = await login({ prefers: "EMAIL" });
    expect(await codeDestination(db, prefersEmail.ph, { smsEnabled: true })).toEqual({ channel: "EMAIL", to: prefersEmail.email });
    const prefersSms = await login({ prefers: "SMS" });
    expect(await codeDestination(db, prefersSms.ph, { smsEnabled: true })).toEqual({ channel: "SMS", to: prefersSms.ph });
  });

  it("uses SMS when email is preferred but there is no email", async () => {
    const noEmail = await login({ email: false, prefers: "EMAIL" });
    expect(await codeDestination(db, noEmail.ph, { smsEnabled: true })).toEqual({ channel: "SMS", to: noEmail.ph });
    expect(await codeChoices(db, noEmail.ph, true)).toEqual({ sms: true, email: false });
  });

  it("lets a one-off choice override the preference, when that channel exists", async () => {
    const m = await login({ prefers: "EMAIL" });
    expect(await codeDestination(db, m.ph, { smsEnabled: true, override: "SMS" })).toEqual({ channel: "SMS", to: m.ph });
    const n = await login();
    expect(await codeDestination(db, n.ph, { smsEnabled: true, override: "EMAIL" })).toEqual({ channel: "EMAIL", to: n.email });
    const none = await login({ email: false });
    expect(await codeDestination(db, none.ph, { smsEnabled: true, override: "EMAIL" })).toEqual({ channel: "SMS", to: none.ph });
  });

  it("always uses email while SMS is off, whatever was chosen, and nothing without one", async () => {
    const m = await login({ prefers: "SMS" });
    expect(await codeDestination(db, m.ph, { smsEnabled: false, override: "SMS" })).toEqual({ channel: "EMAIL", to: m.email });
    expect(await codeChoices(db, m.ph, false)).toEqual({ sms: false, email: true });
    const none = await login({ email: false });
    expect(await codeDestination(db, none.ph, { smsEnabled: false })).toBeNull();
  });

  it("keeps a one-off choice for one code only, and lets it lapse after 2 minutes", async () => {
    const m = await login();
    await setNextCodeChannel(db, m.ph, "EMAIL");
    expect(await takeNextCodeChannel(db, m.ph)).toBe("EMAIL");
    expect(await takeNextCodeChannel(db, m.ph)).toBeNull();

    const at = new Date();
    await setNextCodeChannel(db, m.ph, "SMS", at);
    expect(await takeNextCodeChannel(db, m.ph, new Date(at.getTime() + 3 * 60_000))).toBeNull();
  });

  it("describes where a code went without the full address", () => {
    expect(maskEmail("adaeze@gmail.com")).toBe("a•••@gmail.com");
    expect(describeDestination({ channel: "EMAIL", to: "adaeze@gmail.com" })).toBe("your email a•••@gmail.com");
    expect(describeDestination({ channel: "SMS", to: "+2348031234567" })).toBe("+234803•••67 by SMS");
  });
});
