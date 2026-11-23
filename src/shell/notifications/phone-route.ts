import type { Db } from "@/lib/db";
import { emailForPhone } from "@/shell/auth/reset-by-phone";
import { notifyInBackground, type NotifyInput } from "./notify";
import { readSmsConfig } from "./sms/config";

/** Whether SMS can go out at all (SMS_ENABLED isn't false). */
export const smsOn = (): boolean => readSmsConfig().config.enabled;

/**
 * Where a message meant for a phone number goes: by SMS while SMS is on;
 * while it is switched off, to the email on record for that number
 * (`emailForPhone`: the login's, the member record's or an open invitation's),
 * or nowhere when there is none. Never to an address typed by someone else.
 */
export async function routeToPhone(db: Db, phone: string, smsEnabled = smsOn()): Promise<{ channel: "SMS" | "EMAIL"; recipient: string } | null> {
  if (smsEnabled) return { channel: "SMS", recipient: phone };
  const email = await emailForPhone(db, phone);
  return email ? { channel: "EMAIL", recipient: email } : null;
}

/**
 * A message for a phone number, sent in the background by `routeToPhone`. With
 * SMS off and no email it is still attempted as SMS, so the log records that
 * it couldn't go. The idempotency key gets the channel, as SMS and email are
 * separate messages.
 */
export async function notifyPhoneInBackground(
  db: Db,
  phone: string,
  input: Omit<NotifyInput, "channel" | "recipient" | "subject"> & { subject: string },
): Promise<void> {
  const route = (await routeToPhone(db, phone).catch(() => null)) ?? { channel: "SMS" as const, recipient: phone };
  notifyInBackground(db, {
    ...input,
    idempotencyKey: route.channel === "SMS" ? input.idempotencyKey : `${input.idempotencyKey}:email`,
    channel: route.channel,
    recipient: route.recipient,
    subject: route.channel === "EMAIL" ? input.subject : undefined,
  });
}
