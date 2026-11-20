import { after } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { providerFor, type Channel, type NotificationProvider, type OutboundMessage, type SendResult } from "./providers";
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
  /** Holds a one-time code: masked wherever it would be printed. */
  sensitive?: boolean;
}

/** A failed retryable message is tried this many times in all, then given up on. */
export const MAX_ATTEMPTS = 4;

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
  const outcome = await sendThrough(sender, {
    channel: input.channel,
    to: input.recipient,
    subject: input.subject,
    text: input.text,
    sensitive: input.sensitive,
    reference: input.idempotencyKey,
  });
  // Staging only (the call does nothing elsewhere): keep the text so testers can follow links and enter codes.
  await recordStagingOutbox(db, { channel: input.channel, recipient: input.recipient, subject: input.subject, template: input.template, text: input.text }).catch(() => {});
  const keep = outcome.status === "FAILED" && input.retryable && outcome.retryable;
  await db.notification.update({
    where: { idempotencyKey: input.idempotencyKey },
    data: {
      ...outcome.log,
      attempts: { increment: 1 },
      retrySubject: keep ? (input.subject ?? null) : null,
      retryText: keep ? input.text : null,
    },
  });
  return outcome.status === "SENT";
}

/**
 * Sends one message and turns the result into the notification log's fields:
 * SENT, FAILED or SKIPPED (staging test-number list, SMS off), the provider
 * that handled it, its message id, SMS units, the error and the environment.
 * Never stores the message text.
 */
export async function sendThrough(sender: NotificationProvider, message: OutboundMessage) {
  let status: "SENT" | "FAILED" | "SKIPPED" = "FAILED";
  let response: unknown;
  let result: SendResult | null = null;
  try {
    result = await sender.send(message);
    status = result.skipped ? "SKIPPED" : result.ok ? "SENT" : "FAILED";
    response = { providerMessageId: result.providerMessageId ?? null, response: result.response };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  const error = status === "SENT" ? null : (result?.error ?? (response as { error?: string }).error ?? null);
  return {
    status,
    // A thrown error (network, bug) is worth another try; a refusal only if the provider said so.
    retryable: result ? result.retryable !== false : true,
    log: {
      status,
      provider: result?.provider ?? sender.name,
      providerMessageId: result?.providerMessageId ?? null,
      providerResponse: JSON.parse(JSON.stringify(response ?? null)) as Prisma.InputJsonValue,
      segments: result?.segments ?? null,
      error: error ? error.slice(0, 500) : null,
      environment: result?.environment ?? null,
      sentAt: status === "SENT" ? new Date() : null,
    },
  };
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
