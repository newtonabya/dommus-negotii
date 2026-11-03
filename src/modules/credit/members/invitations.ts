import { randomBytes } from "node:crypto";
import type { Invitation } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { writeAudit } from "@/shell/audit/audit";
import { notify } from "@/shell/notifications/notify";
import {
  INVITATION_TTL_DAYS,
  invitationSchema,
  invitationState,
  isUsable,
  MAX_INVITES_PER_PHONE_PER_WEEK,
  MAX_INVITES_PER_SENDER_PER_DAY,
  type InvitationInput,
} from "./rules";

export interface MemberActor {
  id: string;
  ipAddress: string | null;
}

export class MemberError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "MemberError";
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** A fresh link token; only its SHA-256 is stored. */
export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

export function joinUrl(token: string): string {
  return `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/join/${token}`;
}

/** Enforces the PRD sending limits from the audit trail of sends. */
async function assertWithinLimits(db: Db, actor: MemberActor, phone: string): Promise<void> {
  const now = Date.now();
  const bySender = await db.auditLog.count({
    where: { action: "invitation.sent", userId: actor.id, occurredAt: { gt: new Date(now - DAY) } },
  });
  if (bySender >= MAX_INVITES_PER_SENDER_PER_DAY) {
    throw new MemberError(`You've sent ${MAX_INVITES_PER_SENDER_PER_DAY} invitations in the last 24 hours. Try again later.`);
  }
  const toPhone = await db.auditLog.count({
    where: { action: "invitation.sent", after: { path: ["phone"], equals: phone }, occurredAt: { gt: new Date(now - 7 * DAY) } },
  });
  if (toPhone >= MAX_INVITES_PER_PHONE_PER_WEEK) {
    throw new MemberError(`This number has had ${MAX_INVITES_PER_PHONE_PER_WEEK} invitations this week. Try again later.`);
  }
}

/** Sends the link by SMS (and email when known). Returns whether the SMS was accepted. */
async function deliver(db: Db, invitation: Invitation, token: string): Promise<boolean> {
  const url = joinUrl(token);
  const firstName = invitation.fullName.split(" ")[0];
  const until = invitation.expiresAt.toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "long" });
  const text =
    `Hello ${firstName}, MOAUM Credit Super Store invites you to register as a member: ${url} ` +
    `This link is for you only, works once and expires on ${until}.`;
  const key = `invitation:${invitation.id}:${invitation.sendCount}`;
  const sms = await notify(db, {
    idempotencyKey: `${key}:sms`,
    channel: "SMS",
    recipient: invitation.phone,
    template: "member.invitation",
    text,
    payload: { invitationId: invitation.id },
  });
  if (invitation.email) {
    await notify(db, {
      idempotencyKey: `${key}:email`,
      channel: "EMAIL",
      recipient: invitation.email,
      template: "member.invitation",
      subject: "Your invitation to register with MOAUM Credit Super Store",
      text: `${text}\n\nIf you weren't expecting this, you can ignore it.`,
      payload: { invitationId: invitation.id },
    });
  }
  return sms;
}

async function assertSourceActive(db: Db, remittanceSourceId: string | null): Promise<void> {
  if (!remittanceSourceId) return;
  const source = await db.remittanceSource.findUnique({ where: { id: remittanceSourceId } });
  if (!source?.active) throw new MemberError("Choose an active remittance source.");
}

/** Sends a personal registration link (PRD F5). Admin, GMD and Secretary only — checked by the caller. */
export async function createInvitation(db: Db, actor: MemberActor, input: InvitationInput) {
  const data = invitationSchema.parse(input);

  if (await db.member.findUnique({ where: { phone: data.phone } })) {
    throw new MemberError("This phone number already belongs to a member or a pending registration.");
  }
  if (await db.user.findUnique({ where: { phoneNumber: data.phone } })) {
    throw new MemberError("This phone number already has a portal login.");
  }
  const open = await db.invitation.findFirst({
    where: { phone: data.phone, registeredAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  if (open) throw new MemberError("This number already has an open invitation. Resend that one instead.");
  await assertSourceActive(db, data.remittanceSourceId);
  await assertWithinLimits(db, actor, data.phone);

  const { token, tokenHash } = newInvitationToken();
  const invitation = await db.invitation.create({
    data: {
      fullName: data.fullName,
      phone: data.phone,
      email: data.email,
      remittanceSourceId: data.remittanceSourceId,
      tokenHash,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY),
      sentById: actor.id,
    },
  });
  const sent = await deliver(db, invitation, token);
  if (!sent) await db.invitation.update({ where: { id: invitation.id }, data: { lastSendOk: false } });
  await writeAudit(db, {
    action: "invitation.sent",
    entityType: "Invitation",
    entityId: invitation.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { phone: data.phone, fullName: data.fullName, delivered: sent, resend: false },
  });
  return { invitation, sent };
}

/** Issues a new link (the old one stops working) and sends it again. */
export async function resendInvitation(db: Db, actor: MemberActor, invitationId: string) {
  const current = await db.invitation.findUnique({ where: { id: invitationId } });
  if (!current) throw new MemberError("Invitation not found.");
  const state = invitationState(current);
  if (state === "registered") throw new MemberError("This person has already registered.");
  if (state === "revoked") throw new MemberError("This invitation was revoked. Send a new one.");
  await assertWithinLimits(db, actor, current.phone);

  const { token, tokenHash } = newInvitationToken();
  const invitation = await db.invitation.update({
    where: { id: invitationId },
    data: {
      tokenHash,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY),
      lastSentAt: new Date(),
      sendCount: { increment: 1 },
      openedAt: null,
    },
  });
  const sent = await deliver(db, invitation, token);
  await db.invitation.update({ where: { id: invitationId }, data: { lastSendOk: sent } });
  await writeAudit(db, {
    action: "invitation.sent",
    entityType: "Invitation",
    entityId: invitationId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { phone: invitation.phone, delivered: sent, resend: true },
  });
  return { invitation, sent };
}

/** Stops an invitation link working at once. */
export async function revokeInvitation(db: Db, actor: MemberActor, invitationId: string) {
  const current = await db.invitation.findUnique({ where: { id: invitationId } });
  if (!current) throw new MemberError("Invitation not found.");
  if (!isUsable(invitationState(current)) && invitationState(current) !== "expired") {
    throw new MemberError("Only an invitation that hasn't been used can be revoked.");
  }
  await db.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date(), revokedById: actor.id } });
  await writeAudit(db, {
    action: "invitation.revoke",
    entityType: "Invitation",
    entityId: invitationId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
  });
}

export async function listInvitations(db: Db, take = 200) {
  const rows = await db.invitation.findMany({
    orderBy: { lastSentAt: "desc" },
    take,
    include: { remittanceSource: { select: { name: true } } },
  });
  const senders = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.sentById))] } },
    select: { id: true, name: true },
  });
  const names = new Map(senders.map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...r, state: invitationState(r), sentByName: names.get(r.sentById) ?? "Unknown" }));
}
