import { randomInt, randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { writeAudit } from "@/shell/audit/audit";
import { notify } from "@/shell/notifications/notify";
import { MemberError, type MemberActor } from "./invitations";

/**
 * SMS codes that prove a member owns a new phone number before they ask to
 * switch to it (PRD F5). Kept in Better Auth's verification table, hashed,
 * single use, 10-minute lifetime, 5 tries.
 */
const CODE_TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;
const MAX_SENDS_PER_15_MIN = 3;

const identifier = (userId: string) => `profile-phone:${userId}`;

interface Stored {
  phone: string;
  hash: string;
  tries: number;
}

/** Texts a 6-digit code to the new number. Checks that nobody else uses it. */
export async function sendPhoneChangeCode(db: Db, actor: MemberActor, phone: string): Promise<void> {
  const member = await db.member.findUnique({ where: { userId: actor.id } });
  if (!member) throw new MemberError("No membership is linked to this login.");
  if (member.phone === phone) throw new MemberError("That is already your phone number.");
  if ((await db.member.findUnique({ where: { phone } })) || (await db.user.findUnique({ where: { phoneNumber: phone } }))) {
    throw new MemberError("That number belongs to another member or login.");
  }
  const recent = await db.auditLog.count({
    where: { action: "member.phone_change.code_sent", userId: actor.id, occurredAt: { gt: new Date(Date.now() - 15 * 60_000) } },
  });
  if (recent >= MAX_SENDS_PER_15_MIN) throw new MemberError("Too many codes requested. Wait 15 minutes and try again.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomUUID();
  await db.verification.deleteMany({ where: { identifier: identifier(actor.id) } });
  await db.verification.create({
    data: {
      id,
      identifier: identifier(actor.id),
      value: JSON.stringify({ phone, hash: sha256Hex(code), tries: 0 } satisfies Stored),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  const sent = await notify(db, {
    idempotencyKey: `member.phone_change.code:${id}`,
    channel: "SMS",
    recipient: phone,
    template: "member.phone_change_code",
    text: `Your Dommus Negotii code to confirm this number is ${code}. It expires in 10 minutes. Never share it.`,
  });
  await writeAudit(db, {
    action: "member.phone_change.code_sent",
    entityType: "Member",
    entityId: member.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { phone, delivered: sent },
  });
  if (!sent) throw new MemberError("The SMS couldn't be sent just now. Try again shortly.");
}

/** True and used up when the code matches the latest one sent to `phone`. */
export async function consumePhoneChangeCode(db: Db, userId: string, phone: string, code: string): Promise<boolean> {
  const row = await db.verification.findFirst({ where: { identifier: identifier(userId) }, orderBy: { createdAt: "desc" } });
  if (!row || row.expiresAt < new Date()) return false;
  const stored = JSON.parse(row.value) as Stored;
  if (stored.phone !== phone || stored.tries >= MAX_TRIES) return false;
  if (stored.hash !== sha256Hex(code.trim())) {
    await db.verification.update({ where: { id: row.id }, data: { value: JSON.stringify({ ...stored, tries: stored.tries + 1 }) } });
    return false;
  }
  await db.verification.delete({ where: { id: row.id } });
  return true;
}
