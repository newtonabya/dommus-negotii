import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import { emailForPhone } from "./reset-by-phone";

/**
 * Where a one-time code for a phone number goes. Codes only ever go to the
 * phone itself or to an email already on record (`emailForPhone`), never to
 * an address typed on a screen.
 *
 * - SMS switched off: email, or nowhere if there is none.
 * - A one-off request for this code ("send it by email instead"): that
 *   channel, if it is available.
 * - Otherwise the person's saved preference (My details); members default to SMS.
 */
export type CodeChannel = "SMS" | "EMAIL";
export type CodeDestination = { channel: "SMS"; to: string } | { channel: "EMAIL"; to: string };

export async function codeDestination(
  db: Db,
  phoneNumber: string,
  opts: { smsEnabled: boolean; override?: CodeChannel | null },
): Promise<CodeDestination | null> {
  const email = await emailForPhone(db, phoneNumber);
  const byEmail = email ? ({ channel: "EMAIL", to: email } as const) : null;
  const bySms = { channel: "SMS", to: phoneNumber } as const;
  if (!opts.smsEnabled) return byEmail;
  if (opts.override === "EMAIL") return byEmail ?? bySms;
  if (opts.override === "SMS") return bySms;
  const user = await db.user.findUnique({ where: { phoneNumber }, select: { preferredChannel: true } });
  return user?.preferredChannel === "EMAIL" ? (byEmail ?? bySms) : bySms;
}

/** Which channels a code screen may offer for this number. */
export async function codeChoices(db: Db, phoneNumber: string, smsEnabled: boolean): Promise<{ sms: boolean; email: boolean }> {
  return { sms: smsEnabled, email: (await emailForPhone(db, phoneNumber)) !== null };
}

/*
 * The one-off switch. Better Auth calls our sender with only the phone number
 * and the code, so the choice is left for it in the verification table (shared
 * by every server instance) just before the code is requested, and taken (used
 * up) when the code is sent. It lapses after 2 minutes.
 */
const NEXT = "code-channel:";
const NEXT_TTL_MS = 2 * 60_000;

export async function setNextCodeChannel(db: Db, phoneNumber: string, channel: CodeChannel, now = new Date()): Promise<void> {
  await db.verification.deleteMany({ where: { identifier: NEXT + phoneNumber } });
  await db.verification.create({ data: { id: randomUUID(), identifier: NEXT + phoneNumber, value: channel, expiresAt: new Date(now.getTime() + NEXT_TTL_MS) } });
}

export async function takeNextCodeChannel(db: Db, phoneNumber: string, now = new Date()): Promise<CodeChannel | null> {
  const row = await db.verification.findFirst({ where: { identifier: NEXT + phoneNumber }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  await db.verification.deleteMany({ where: { identifier: NEXT + phoneNumber } });
  if (row.expiresAt <= now) return null;
  return row.value === "EMAIL" || row.value === "SMS" ? row.value : null;
}

/** a•••@gmail.com, for telling someone where their code went without showing the whole address. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** +234803•••17 */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 7)}•••${e164.slice(-2)}`;
}

export function describeDestination(d: CodeDestination): string {
  return d.channel === "EMAIL" ? `your email ${maskEmail(d.to)}` : `${maskPhone(d.to)} by SMS`;
}
