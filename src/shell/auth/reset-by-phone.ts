import type { Db } from "@/lib/db";

/**
 * How a password reset asked for by phone number reaches the person. With SMS
 * on, the usual 6-digit code. With SMS switched off, a reset link to the
 * account's email instead, when it has a real one (members with no email have
 * a `…@members.dommus.invalid` placeholder). The caller never tells the
 * visitor which of "email" or "none" happened, so the page doesn't reveal
 * whether a number has an account.
 */
export type PhoneResetRoute = { route: "sms" } | { route: "email"; email: string } | { route: "none" };

const isReal = (email: string | null | undefined): email is string => !!email && !email.toLowerCase().endsWith(".invalid");

/**
 * Where a phone code goes while SMS is switched off: the email of whoever the
 * number belongs to. The login's own email first, then the member record's,
 * then the latest open invitation to that number (registration and
 * activation happen before a login has a usable email). Null: no email known.
 */
export async function emailForPhone(db: Db, phoneNumber: string, now = new Date()): Promise<string | null> {
  const user = await db.user.findUnique({ where: { phoneNumber }, select: { email: true, deactivatedAt: true } });
  if (user?.deactivatedAt) return null;
  if (isReal(user?.email)) return user.email;
  const member = await db.member.findUnique({ where: { phone: phoneNumber }, select: { email: true } });
  if (isReal(member?.email)) return member.email;
  const invitation = await db.invitation.findFirst({
    where: { phone: phoneNumber, email: { not: null }, registeredAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { email: true },
  });
  return isReal(invitation?.email) ? invitation.email : null;
}

export async function phoneResetRoute(db: Db, phoneNumber: string, smsEnabled: boolean): Promise<PhoneResetRoute> {
  if (smsEnabled) return { route: "sms" };
  // Only the login's own email: a password reset link is sent to the address Better Auth knows for the account.
  const user = await db.user.findUnique({ where: { phoneNumber }, select: { email: true, deactivatedAt: true } });
  if (!user || user.deactivatedAt || !isReal(user.email)) return { route: "none" };
  return { route: "email", email: user.email };
}
