import { after } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { providerFor, type Channel, type NotificationProvider } from "./providers";
import { recordStagingOutbox } from "./staging-outbox";

export interface NotifyInput {
  /** Same key → sent at most once (PRD F15). */
  idempotencyKey: string;
  channel: Channel;
  recipient: string;
  template: string;
  subject?: string;
  /** The message text. Never stored: it can hold codes and reset links. */
  text: string;
  /** Non-secret details kept on the notification log. */
  payload?: Record<string, string | number | boolean | null>;
  /**
   * Set for messages that are safe to keep and send again if the provider
   * fails (status notices). Never set it for codes or links.
   */
  retryable?: boolean;
}

/** A failed retryable message is tried this many times in all, then given up on. */
export const MAX_ATTEMPTS = 4;
const RETRY_WINDOW_MS = 3 * 86_400_000;

/**
 * Queues, sends and logs one notification (PRD F2). Returns false when the
 * idempotency key was already used, so the message was not sent again.
 */
export async function notify(db: Db, input: NotifyInput, provider?: NotificationProvider): Promise<boolean> {
  const { count } = await db.notification.createMany({
    data: [
      {
        idempotencyKey: input.idempotencyKey,
        channel: input.channel,
        recipient: input.recipient,
        template: input.template,
        payload: (input.payload ?? {}) as Prisma.InputJsonObject,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return false;

  const sender = provider ?? providerFor(input.channel);
  let status: "SENT" | "FAILED" = "FAILED";
  let response: unknown;
  try {
    const result = await sender.send({
      channel: input.channel,
      to: input.recipient,
      subject: input.subject,
      text: input.text,
    });
    status = result.ok ? "SENT" : "FAILED";
    response = { providerMessageId: result.providerMessageId ?? null, response: result.response };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  // Staging only: keep the text so testers can follow links and enter codes.
  if (sender.name === "console") {
    await recordStagingOutbox(db, { channel: input.channel, recipient: input.recipient, subject: input.subject, template: input.template, text: input.text }).catch(() => {});
  }
  await db.notification.update({
    where: { idempotencyKey: input.idempotencyKey },
    data: {
      status,
      provider: sender.name,
      providerResponse: JSON.parse(JSON.stringify(response ?? null)) as Prisma.InputJsonValue,
      attempts: { increment: 1 },
      sentAt: status === "SENT" ? new Date() : null,
      retrySubject: status === "FAILED" && input.retryable ? (input.subject ?? null) : null,
      retryText: status === "FAILED" && input.retryable ? input.text : null,
    },
  });
  return status === "SENT";
}

/**
 * Sends failed retryable messages again (the scheduled job). A message that
 * still fails on its last attempt is given up on: its text is cleared and it
 * is counted, so the Admins can be told the provider keeps failing.
 */
export async function retryFailed(
  db: Db,
  now = new Date(),
  provider?: NotificationProvider,
  /** Tests limit a run to their own messages. */
  keyPrefix?: string,
): Promise<{ retried: number; sent: number; gaveUp: number }> {
  const since = new Date(now.getTime() - RETRY_WINDOW_MS);
  const waiting = await db.notification.findMany({
    where: { status: "FAILED", retryText: { not: null }, createdAt: { gte: since }, ...(keyPrefix ? { idempotencyKey: { startsWith: keyPrefix } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  let sent = 0;
  let gaveUp = 0;
  for (const n of waiting) {
    const sender = provider ?? providerFor(n.channel);
    let ok = false;
    let response: unknown;
    try {
      const result = await sender.send({ channel: n.channel, to: n.recipient, subject: n.retrySubject ?? undefined, text: n.retryText as string });
      ok = result.ok;
      response = { providerMessageId: result.providerMessageId ?? null, response: result.response };
    } catch (error) {
      response = { error: error instanceof Error ? error.message : String(error) };
    }
    const last = !ok && n.attempts + 1 >= MAX_ATTEMPTS;
    if (ok) sent++;
    if (last) gaveUp++;
    await db.notification.update({
      where: { id: n.id },
      data: {
        status: ok ? "SENT" : "FAILED",
        provider: sender.name,
        providerResponse: JSON.parse(JSON.stringify(response ?? null)) as Prisma.InputJsonValue,
        attempts: { increment: 1 },
        sentAt: ok ? new Date() : null,
        ...(ok || last ? { retrySubject: null, retryText: null } : {}),
      },
    });
  }
  // Past the retry window: stop keeping the text.
  await db.notification.updateMany({ where: { retryText: { not: null }, createdAt: { lt: since } }, data: { retrySubject: null, retryText: null } });
  return { retried: waiting.length, sent, gaveUp };
}

/**
 * Sends without making the request wait on the provider. Inside a request it
 * uses Next.js `after`, so a serverless function is kept alive until the
 * message is sent (a bare promise can be cut off when the response ends).
 * Outside a request (tests, scripts) it simply runs.
 */
export function notifyInBackground(db: Db, input: NotifyInput): void {
  const run = () =>
    notify(db, input).catch((error: unknown) => {
      console.error(`[notification] ${input.template} to ${input.recipient} failed`, error);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}
