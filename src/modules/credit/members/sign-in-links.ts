import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { writeAudit } from "@/shell/audit/audit";
import { MemberError, type MemberActor } from "./invitations";
import { CONSENT_VERSION } from "./rules";

/**
 * Sign-in links a Loan Officer hands to a member in person (or by WhatsApp):
 * the member opens it and sets a password, with no SMS code. For members who
 * can't get texts (SMS switched off or not reaching them) and have no email:
 * imported members who never activated, and anyone who forgot their password.
 *
 * Seeing the member and their ID stands in for the SMS code, so the link
 * proves the phone is theirs. Kept in Better Auth's verification table: only
 * the SHA-256 of the token is stored, 30-minute lifetime, single use, and a new
 * link cancels the member's earlier ones. Issuing and using are audited.
 */
export const SIGN_IN_LINK_TTL_MS = 30 * 60_000;
const PREFIX = "member-signin:";

interface Stored {
  memberId: string;
  userId: string;
  issuedById: string;
}

export interface IssuedSignInLink {
  token: string;
  path: string;
  expiresAt: Date;
  /** The member has no password yet (imported, never activated). */
  firstTime: boolean;
}

/** Creates a link for `memberId`. Only ACTIVE or PENDING members, never the actor's own record. */
export async function issueSignInLink(db: PrismaClient, actor: MemberActor, memberId: string, now = new Date()): Promise<IssuedSignInLink> {
  const member = await db.member.findUnique({ where: { id: memberId }, include: { user: { select: { id: true, deactivatedAt: true } } } });
  if (!member) throw new MemberError("Member not found.");
  if (member.userId === actor.id) throw new MemberError("You can't make a sign-in link for your own membership. Ask another Loan Officer.");
  if (member.status !== "ACTIVE" && member.status !== "PENDING") throw new MemberError(`This membership is ${member.status.toLowerCase()}, so it can't sign in.`);
  if (member.user.deactivatedAt) throw new MemberError("This member's login has been switched off.");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SIGN_IN_LINK_TTL_MS);
  const firstTime = !(await db.account.findFirst({ where: { userId: member.userId, providerId: "credential", password: { not: null } } }));

  await db.$transaction(async (tx) => {
    // One live link per member: an earlier one stops working.
    await tx.verification.deleteMany({ where: { identifier: { startsWith: PREFIX }, value: { contains: `"memberId":"${member.id}"` } } });
    await tx.verification.create({
      data: {
        id: randomUUID(),
        identifier: PREFIX + sha256Hex(token),
        value: JSON.stringify({ memberId: member.id, userId: member.userId, issuedById: actor.id } satisfies Stored),
        expiresAt,
      },
    });
    await writeAudit(tx, {
      action: "member.signin_link.issued",
      entityType: "Member",
      entityId: member.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      after: { expiresAt: expiresAt.toISOString(), firstTime },
    });
  }, TX_OPTIONS);

  return { token, path: `/access/${token}`, expiresAt, firstTime };
}

async function liveLink(db: Db, token: string, now: Date) {
  const row = token ? await db.verification.findFirst({ where: { identifier: PREFIX + sha256Hex(token) } }) : null;
  if (!row || row.expiresAt <= now) throw new MemberError("This sign-in link has expired or was already used. Ask a MOAUM Loan Officer for a new one.");
  return { row, stored: JSON.parse(row.value) as Stored };
}

/** What the link page shows: whose link it is and whether they still have to accept the notice. */
export async function signInLinkDetails(db: Db, token: string, now = new Date()) {
  const { stored } = await liveLink(db, token, now);
  const member = await db.member.findUnique({ where: { id: stored.memberId } });
  if (!member || (member.status !== "ACTIVE" && member.status !== "PENDING")) throw new MemberError("This membership can't sign in. Contact MOAUM.");
  return { fullName: member.fullName, memberNo: member.memberNo, phone: member.phone, needsConsent: !member.consentAt };
}

export const signInLinkSchema = z
  .object({
    password: z.string().min(10, "Password: use at least 10 characters.").max(128, "Password: use at most 128 characters."),
    confirmPassword: z.string(),
    consent: z.boolean().default(false),
  })
  .refine((v) => v.password === v.confirmPassword, { message: "The two passwords don't match." });

export interface SignInLinkDeps {
  hashPassword: (password: string) => Promise<string>;
  isPasswordCompromised: (password: string) => Promise<boolean>;
  newId: () => string;
}

/**
 * Sets the member's password from a link and uses the link up. A first-time
 * member also accepts the data protection notice; their open activation link,
 * if any, is closed. Existing sessions end, as with any password reset.
 */
export async function redeemSignInLink(
  db: PrismaClient,
  token: string,
  input: z.input<typeof signInLinkSchema>,
  deps: SignInLinkDeps,
  ipAddress: string | null,
  now = new Date(),
): Promise<{ firstTime: boolean }> {
  const { row, stored } = await liveLink(db, token, now);
  const parsed = signInLinkSchema.safeParse(input);
  if (!parsed.success) throw new MemberError(parsed.error.issues[0]?.message ?? "Check the form.");
  const member = await db.member.findUnique({ where: { id: stored.memberId } });
  if (!member || member.userId !== stored.userId || (member.status !== "ACTIVE" && member.status !== "PENDING")) {
    throw new MemberError("This membership can't sign in. Contact MOAUM.");
  }
  if (!member.consentAt && !parsed.data.consent) throw new MemberError("You must accept the data protection notice to continue.");

  let compromised = false;
  try {
    compromised = await deps.isPasswordCompromised(parsed.data.password);
  } catch {
    throw new MemberError("We couldn't check your password right now (network problem). Please try again.");
  }
  if (compromised) throw new MemberError("Password: this one has appeared in a known data breach, so others could guess it. Choose a different password.");

  const passwordHash = await deps.hashPassword(parsed.data.password);
  return db.$transaction(async (tx) => {
    // Single use, even if two tabs submit at once: only the one that deletes the row goes on.
    const used = await tx.verification.deleteMany({ where: { id: row.id, expiresAt: { gt: now } } });
    if (used.count !== 1) throw new MemberError("This sign-in link has expired or was already used. Ask a MOAUM Loan Officer for a new one.");

    const account = await tx.account.findFirst({ where: { userId: member.userId, providerId: "credential" } });
    const firstTime = !account?.password;
    if (account) await tx.account.update({ where: { id: account.id }, data: { password: passwordHash } });
    else await tx.account.create({ data: { id: deps.newId(), userId: member.userId, providerId: "credential", accountId: member.userId, password: passwordHash } });

    await tx.user.update({ where: { id: member.userId }, data: { phoneNumberVerified: true } });
    await tx.session.deleteMany({ where: { userId: member.userId } });
    if (!member.consentAt) await tx.member.update({ where: { id: member.id }, data: { consentAt: now, consentVersion: CONSENT_VERSION } });
    if (member.invitationId) {
      await tx.invitation.updateMany({ where: { id: member.invitationId, type: "ACTIVATION", registeredAt: null }, data: { registeredAt: now } });
    }
    await writeAudit(tx, {
      action: "member.signin_link.used",
      entityType: "Member",
      entityId: member.id,
      userId: member.userId,
      ipAddress,
      after: { issuedById: stored.issuedById, firstTime, ...(member.consentAt ? {} : { consentVersion: CONSENT_VERSION }) },
    });
    return { firstTime };
  }, TX_OPTIONS);
}
