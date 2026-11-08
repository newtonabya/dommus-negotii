/**
 * The staging outbox keeps message text only when APP_STAGE=staging; any
 * other stage stores nothing. Skipped when TEST_DATABASE_URL is not set.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { recordStagingOutbox } from "@/shell/notifications/staging-outbox";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

describeDb("staging outbox", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = createClient(url as string);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("stores message text on staging only", async () => {
    const recipient = `+23480${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`;
    const message = { channel: "SMS" as const, recipient, template: "test.outbox", text: "Your code is 123456" };
    await recordStagingOutbox(db, message, { NODE_ENV: "production" } as NodeJS.ProcessEnv);
    await recordStagingOutbox(db, message, { NODE_ENV: "production", APP_STAGE: "production" } as NodeJS.ProcessEnv);
    expect(await db.stagingOutbox.count({ where: { recipient } })).toBe(0);
    await recordStagingOutbox(db, message, { NODE_ENV: "production", APP_STAGE: "staging" } as NodeJS.ProcessEnv);
    expect(await db.stagingOutbox.findFirst({ where: { recipient } })).toMatchObject({ text: "Your code is 123456", template: "test.outbox" });
  });
});
