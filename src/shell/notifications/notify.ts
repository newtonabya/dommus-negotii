import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { providerFor, type Channel, type NotificationProvider } from "./providers";

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
}

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
  await db.notification.update({
    where: { idempotencyKey: input.idempotencyKey },
    data: {
      status,
      provider: sender.name,
      providerResponse: JSON.parse(JSON.stringify(response ?? null)) as Prisma.InputJsonValue,
      attempts: { increment: 1 },
      sentAt: status === "SENT" ? new Date() : null,
    },
  });
  return status === "SENT";
}

/** Fire-and-forget wrapper for auth flows that must not wait on a provider. */
export function notifyInBackground(db: Db, input: NotifyInput): void {
  void notify(db, input).catch((error: unknown) => {
    console.error(`[notification] ${input.template} to ${input.recipient} failed`, error);
  });
}
