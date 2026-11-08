import type { Db } from "@/lib/db";
import { isStaging } from "@/lib/stage";
import type { Channel } from "./providers";

/** How long staging keeps message text. */
export const OUTBOX_HOURS = 24;

/**
 * STAGING ONLY. Keeps the text of a message the console provider "sent", so
 * testers can open invitation links and enter codes. Does nothing unless
 * APP_STAGE=staging; production never stores message text.
 */
export async function recordStagingOutbox(
  db: Db,
  message: { channel: Channel; recipient: string; subject?: string; template: string; text: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isStaging(env)) return;
  await db.stagingOutbox.create({
    data: { channel: message.channel, recipient: message.recipient, subject: message.subject ?? null, template: message.template, text: message.text },
  });
  await db.stagingOutbox.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - OUTBOX_HOURS * 3_600_000) } } });
}

export async function listStagingOutbox(db: Db, take = 200) {
  return db.stagingOutbox.findMany({
    where: { createdAt: { gte: new Date(Date.now() - OUTBOX_HOURS * 3_600_000) } },
    orderBy: { createdAt: "desc" },
    take,
  });
}
