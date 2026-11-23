import { after } from "next/server";
import type { Prisma, Role } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { MAX_ATTEMPTS, sendThrough } from "./notify";
import { smsOn } from "./phone-route";
import { providerFor, type Channel, type NotificationProvider } from "./providers";
import { recordStagingOutbox } from "./staging-outbox";

/**
 * Status messages (PRD F15). A message is queued in the same transaction as
 * the change it reports, so nothing is sent for work that was rolled back, and
 * delivered right after the request (`deliverSoon`) or by the scheduled job.
 * Each one is sent once: the idempotency key is `<key>:<user id>:<channel>`.
 * Only for notices that hold no code or link.
 */
export interface Notice {
  /** Trigger and entity, e.g. `loan.approved:<loan id>`. */
  key: string;
  template: string;
  subject: string;
  text: string;
}

/** Members' logins use a placeholder address when they gave no email. */
const hasRealEmail = (email: string) => !email.endsWith(".invalid");

interface Recipient {
  id: string;
  email: string;
  phoneNumber: string | null;
  preferredChannel: Channel | null;
  isStaff: boolean;
}

/**
 * The channel a status message takes: the user's choice if it can be used,
 * else SMS for members and email for staff. While SMS is switched off, email
 * whenever there is one (an SMS row is still queued for someone without email,
 * so the log shows the message couldn't go).
 */
export function channelFor(user: Omit<Recipient, "id">, smsEnabled = true): { channel: Channel; recipient: string } | null {
  const sms = user.phoneNumber ? { channel: "SMS" as const, recipient: user.phoneNumber } : null;
  const email = hasRealEmail(user.email) ? { channel: "EMAIL" as const, recipient: user.email } : null;
  if (!smsEnabled) return email ?? sms;
  const wanted = user.preferredChannel ?? (user.isStaff ? "EMAIL" : "SMS");
  return wanted === "SMS" ? (sms ?? email) : (email ?? sms);
}

async function recipients(db: Db, userIds: string[]): Promise<Recipient[]> {
  if (userIds.length === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(userIds)] }, deactivatedAt: null },
    select: { id: true, email: true, phoneNumber: true, preferredChannel: true, roles: { where: { revokedAt: null, role: { not: "MEMBER" } }, select: { role: true }, take: 1 } },
  });
  return users.map((u) => ({ id: u.id, email: u.email, phoneNumber: u.phoneNumber, preferredChannel: u.preferredChannel, isStaff: u.roles.length > 0 }));
}

async function queue(db: Db, rows: Array<{ user: Recipient; notice: Notice; force?: Channel }>): Promise<number> {
  const data: Prisma.NotificationCreateManyInput[] = [];
  const inbox: Prisma.UserMessageCreateManyInput[] = [];
  const smsEnabled = smsOn();
  for (const { user, notice, force } of rows) {
    // Members keep a copy to read in the portal, whether or not any channel reaches them (one per message).
    if (!user.isStaff) inbox.push({ userId: user.id, key: `${notice.key}:${user.id}`, subject: notice.subject, text: notice.text });
    // A message meant for SMS goes by email instead while SMS is switched off, when there is an email.
    const wanted = force === "SMS" && !smsEnabled && hasRealEmail(user.email) ? "EMAIL" : force;
    const to = wanted
      ? wanted === "SMS"
        ? user.phoneNumber && { channel: wanted, recipient: user.phoneNumber }
        : hasRealEmail(user.email) && { channel: wanted, recipient: user.email }
      : channelFor(user, smsEnabled);
    if (!to) continue;
    data.push({
      idempotencyKey: `${notice.key}:${user.id}:${to.channel}`,
      channel: to.channel,
      recipient: to.recipient,
      template: notice.template,
      payload: { userId: user.id, key: notice.key },
      retrySubject: notice.subject,
      retryText: notice.text,
    });
  }
  if (inbox.length > 0) await db.userMessage.createMany({ data: inbox, skipDuplicates: true });
  if (data.length === 0) return 0;
  return (await db.notification.createMany({ data, skipDuplicates: true })).count;
}

/** A member's own messages, newest first. */
export async function recentMessages(db: Db, userId: string, take = 10) {
  return db.userMessage.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take, select: { id: true, subject: true, text: true, createdAt: true } });
}

/** Queues one notice for one user (by login id). */
export async function queueForUser(db: Db, userId: string | null | undefined, notice: Notice): Promise<number> {
  if (!userId) return 0;
  return queue(db, (await recipients(db, [userId])).map((user) => ({ user, notice })));
}

/** Queues a notice per member; each entry may carry its own text. */
export async function queueForMembers(db: Db, notices: Array<{ memberId: string; notice: Notice }>): Promise<number> {
  if (notices.length === 0) return 0;
  const members = await db.member.findMany({ where: { id: { in: notices.map((n) => n.memberId) } }, select: { id: true, userId: true } });
  const userOf = new Map(members.map((m) => [m.id, m.userId]));
  const users = new Map((await recipients(db, members.flatMap((m) => (m.userId ? [m.userId] : [])))).map((u) => [u.id, u]));
  return queue(
    db,
    notices.flatMap(({ memberId, notice }) => {
      const user = users.get(userOf.get(memberId) ?? "");
      return user ? [{ user, notice }] : [];
    }),
  );
}

export const queueForMember = (db: Db, memberId: string, notice: Notice) => queueForMembers(db, [{ memberId, notice }]);

/** Queues a notice, by email, for every active holder of any of the roles. */
export async function queueForRoles(db: Db, roles: Role[], notice: Notice, except?: string | null): Promise<number> {
  const holders = await db.userModuleRole.findMany({ where: { role: { in: roles }, revokedAt: null, user: { deactivatedAt: null } }, select: { userId: true } });
  const ids = [...new Set(holders.map((h) => h.userId))].filter((id) => id !== except);
  return queue(db, (await recipients(db, ids)).map((user) => ({ user: { ...user, isStaff: true }, notice })));
}

/** Queues a notice on a named channel (announcements choose SMS and/or email). */
export async function queueOnChannel(db: Db, userIds: string[], channel: Channel, notice: Notice): Promise<number> {
  return queue(db, (await recipients(db, userIds)).map((user) => ({ user, notice, force: channel })));
}

export interface DeliveryResult {
  tried: number;
  sent: number;
  gaveUp: number;
}

/**
 * Sends queued messages, and failed ones that may be tried again. Safe to run
 * from several places at once: each message is claimed before it is sent.
 * After its last attempt a message is given up on and its text cleared.
 */
export async function deliverQueued(
  db: Db,
  options: { now?: Date; provider?: NotificationProvider; keyPrefix?: string; includeFailed?: boolean; take?: number } = {},
): Promise<DeliveryResult> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 3 * 86_400_000);
  const waiting = await db.notification.findMany({
    where: {
      status: { in: options.includeFailed ? ["QUEUED", "FAILED"] : ["QUEUED"] },
      retryText: { not: null },
      createdAt: { gte: since },
      ...(options.keyPrefix ? { idempotencyKey: { startsWith: options.keyPrefix } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: options.take ?? 300,
  });
  let sent = 0;
  let gaveUp = 0;
  let tried = 0;
  const sendOne = async (n: (typeof waiting)[number]) => {
    // Claim it: whoever raises `attempts` first sends it.
    const claimed = await db.notification.updateMany({ where: { id: n.id, attempts: n.attempts, status: n.status }, data: { attempts: { increment: 1 } } });
    if (claimed.count !== 1) return;
    tried++;
    const sender = options.provider ?? providerFor(n.channel);
    const outcome = await sendThrough(sender, { channel: n.channel, to: n.recipient, subject: n.retrySubject ?? undefined, text: n.retryText as string, reference: n.idempotencyKey });
    const ok = outcome.status === "SENT";
    // Staging only (does nothing elsewhere): testers read the text in the Staging outbox.
    await recordStagingOutbox(db, { channel: n.channel, recipient: n.recipient, subject: n.retrySubject ?? undefined, template: n.template, text: n.retryText as string }).catch(() => {});
    // Give up after the last attempt, or at once when another try can't help (bad number, sender ID, skipped).
    const last = !ok && (n.attempts + 1 >= MAX_ATTEMPTS || !outcome.retryable || outcome.status === "SKIPPED");
    if (ok) sent++;
    if (last && outcome.status !== "SKIPPED") gaveUp++;
    await db.notification.update({
      where: { id: n.id },
      data: { ...outcome.log, ...(ok || last ? { retrySubject: null, retryText: null } : {}) },
    });
  };
  // A few at a time: fast enough for an announcement, gentle on the provider.
  for (let i = 0; i < waiting.length; i += 8) await Promise.all(waiting.slice(i, i + 8).map(sendOne));
  // Past the retry window: stop keeping the text.
  await db.notification.updateMany({ where: { retryText: { not: null }, createdAt: { lt: since } }, data: { retrySubject: null, retryText: null } });
  return { tried, sent, gaveUp };
}

/**
 * Delivers what the current request queued, after the response is sent. Outside
 * a request (tests, scripts) it does nothing: call `deliverQueued` there.
 */
export function deliverSoon(db: Db): void {
  try {
    after(() => deliverQueued(db).catch((error: unknown) => console.error("[notification] delivery failed", error)));
  } catch {
    // Not in a request: the scheduled job delivers it.
  }
}

/** The scheduled job's pass: queued messages nobody delivered yet, and failed ones that may be tried again. */
export async function retryFailed(db: Db, now = new Date(), provider?: NotificationProvider, keyPrefix?: string): Promise<{ retried: number; sent: number; gaveUp: number }> {
  const result = await deliverQueued(db, { now, provider, keyPrefix, includeFailed: true });
  return { retried: result.tried, sent: result.sent, gaveUp: result.gaveUp };
}
