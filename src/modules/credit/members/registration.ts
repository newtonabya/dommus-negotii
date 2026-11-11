import { z } from "zod";
import type { Invitation, PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { linkEvidence } from "@/evidence/service";
import { writeAudit } from "@/shell/audit/audit";
import { notifyInBackground } from "@/shell/notifications/notify";
import { MemberError } from "./invitations";
import {
  CONSENT_VERSION,
  invitationState,
  MAX_CODES_PER_INVITATION_PER_15_MIN,
  placeholderEmail,
  registrationSchema,
  type RegistrationInput,
} from "./rules";
import { deliverSoon, queueForUser } from "@/shell/notifications/messages";

/** The uploader id used for files a registrant uploads before they have a login. */
export function registrantActorId(invitationId: string): string {
  return `invitation:${invitationId}`;
}

/** Finds a usable invitation by its link token, or throws a message safe to show. */
export async function usableInvitation(db: Db, token: string): Promise<Invitation> {
  const invitation = token ? await db.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } }) : null;
  const state = invitation ? invitationState(invitation) : null;
  if (!invitation || !state) throw new MemberError("This registration link isn't valid. Ask MOAUM for a new one.");
  if (state === "registered") throw new MemberError("This link has already been used to register. Sign in instead.");
  if (state === "revoked") throw new MemberError("This registration link was cancelled. Ask MOAUM for a new one.");
  if (state === "expired") throw new MemberError("This registration link has expired. Ask MOAUM to send a new one.");
  return invitation;
}

/** Records the first time a link is opened (status OPENED). */
export async function markOpened(db: Db, invitation: Invitation): Promise<void> {
  if (invitation.openedAt) return;
  await db.invitation.update({ where: { id: invitation.id }, data: { openedAt: new Date() } });
  await writeAudit(db, { action: "invitation.opened", entityType: "Invitation", entityId: invitation.id });
}

/** Sends a 6-digit code to the invited phone, at most 3 times per 15 minutes. */
export async function sendRegistrationCode(
  db: Db,
  token: string,
  sendCode: (phone: string) => Promise<void>,
  ipAddress: string | null,
): Promise<void> {
  const invitation = await usableInvitation(db, token);
  const recent = await db.auditLog.count({
    where: {
      action: "member.registration.code_sent",
      entityId: invitation.id,
      occurredAt: { gt: new Date(Date.now() - 15 * 60_000) },
    },
  });
  if (recent >= MAX_CODES_PER_INVITATION_PER_15_MIN) {
    throw new MemberError("Too many codes requested. Wait 15 minutes and try again.");
  }
  await sendCode(invitation.phone);
  await writeAudit(db, { action: "member.registration.code_sent", entityType: "Invitation", entityId: invitation.id, ipAddress });
}

export interface RegistrationDeps {
  /** Checks and uses up the SMS code sent to the phone. */
  verifyCode: (phone: string, code: string) => Promise<boolean>;
  hashPassword: (password: string) => Promise<string>;
  isPasswordCompromised: (password: string) => Promise<boolean>;
  newId: () => string;
}

/**
 * Checks a new password before the SMS code is sent: long enough, typed the
 * same twice, and not one that has leaked in a known data breach.
 */
export async function checkNewPassword(db: Db, token: string, password: string, confirmPassword: string, isCompromised: (password: string) => Promise<boolean>): Promise<void> {
  await usableInvitation(db, token);
  if (password.length < 10) throw new MemberError("Password: use at least 10 characters.");
  if (password.length > 128) throw new MemberError("Password: use at most 128 characters.");
  if (password !== confirmPassword) throw new MemberError("The two passwords don't match.");
  let compromised = false;
  try {
    compromised = await isCompromised(password);
  } catch {
    throw new MemberError("We couldn't check your password right now (network problem). Please try again.");
  }
  if (compromised) throw new MemberError(COMPROMISED);
}

const COMPROMISED = "Password: this one has appeared in a known data breach, so others could guess it. Choose a different password.";

/** Which field a form problem is about, so the message makes sense on any screen. */
const FIELD_LABEL: Record<string, string> = {
  fullName: "Full name",
  email: "Email",
  address: "Home address",
  moaumIdNumber: "MOAUM ID card number",
  nextOfKinName: "Next of kin's name",
  nextOfKinPhone: "Next of kin's phone",
  password: "Password",
  confirmPassword: "Password",
};

/**
 * Checks everything on the registration form except the SMS code. Run before
 * the code is sent, so a mistake is shown on the form it belongs to (and no
 * SMS is spent on a form that can't succeed), and again at the final step.
 */
export async function checkRegistrationDetails(db: Db, token: string, input: RegistrationInput) {
  const invitation = await usableInvitation(db, token);
  if (invitation.type !== "REGISTRATION") throw new MemberError("This link is for setting up an existing membership.");
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const label = FIELD_LABEL[String(issue?.path[0] ?? "")];
    const message = issue?.message ?? "Check the form.";
    throw new MemberError(label ? `${label}: ${message.charAt(0).toLowerCase()}${message.slice(1)}` : message);
  }
  const data = parsed.data;
  const loginEmail = data.email ?? placeholderEmail(invitation.phone);

  if (await db.member.findUnique({ where: { moaumIdNumber: data.moaumIdNumber } })) {
    throw new MemberError("A member with this MOAUM ID card number is already registered. Contact MOAUM if this is a mistake.");
  }
  if (await db.member.findUnique({ where: { phone: invitation.phone } })) {
    throw new MemberError("This phone number is already registered.");
  }
  if (await db.user.findUnique({ where: { phoneNumber: invitation.phone } })) {
    throw new MemberError("This phone number already has a portal login.");
  }
  if (await db.user.findUnique({ where: { email: loginEmail } })) {
    throw new MemberError("This email address is already used by another account. Use a different one or leave it empty.");
  }
  if (data.remittanceSourceId) {
    const source = await db.remittanceSource.findUnique({ where: { id: data.remittanceSourceId } });
    if (!source?.active) throw new MemberError("Choose your remittance source from the list.");
  }
  return { invitation, data, loginEmail };
}

/**
 * Turns a usable invitation into a PENDING member with a verified phone and a
 * login (PRD F5). Everything is written in one transaction.
 */
export async function registerMember(
  db: PrismaClient,
  token: string,
  input: RegistrationInput & { code: string },
  deps: RegistrationDeps,
  ipAddress: string | null,
) {
  const { invitation, data, loginEmail } = await checkRegistrationDetails(db, token, input);

  const scan = await db.evidenceUpload.findFirst({
    where: { evidenceId: data.idScanEvidenceId, uploadedById: registrantActorId(invitation.id), finishedAt: { not: null } },
  });
  const scanFile = scan ? await db.evidenceFile.findUnique({ where: { id: data.idScanEvidenceId } }) : null;
  if (!scanFile || !["image/jpeg", "image/png", "application/pdf"].includes(scanFile.mimeType)) {
    throw new MemberError("Upload a JPG, PNG or PDF scan of your MOAUM ID card.");
  }

  let compromised = false;
  try {
    compromised = await deps.isPasswordCompromised(data.password);
  } catch {
    throw new MemberError("We couldn't check your password right now (network problem). Please try again.");
  }
  if (compromised) throw new MemberError(COMPROMISED);

  if (!(await deps.verifyCode(invitation.phone, input.code.trim()))) {
    throw new MemberError("That code didn't work. Check the SMS or request a new code.");
  }

  const passwordHash = await deps.hashPassword(data.password);
  const userId = deps.newId();
  const now = new Date();

  const member = await db.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: userId,
        name: data.fullName,
        email: loginEmail,
        emailVerified: false,
        phoneNumber: invitation.phone,
        phoneNumberVerified: true,
      },
    });
    await tx.account.create({
      data: { id: deps.newId(), userId, providerId: "credential", accountId: userId, password: passwordHash },
    });
    const created = await tx.member.create({
      data: {
        userId,
        fullName: data.fullName,
        phone: invitation.phone,
        email: data.email,
        address: data.address,
        moaumIdNumber: data.moaumIdNumber,
        idScanEvidenceId: data.idScanEvidenceId,
        nextOfKinName: data.nextOfKinName,
        nextOfKinPhone: data.nextOfKinPhone,
        remittanceSourceId: data.remittanceSourceId,
        consentAt: now,
        consentVersion: CONSENT_VERSION,
        invitationId: invitation.id,
        invitedById: invitation.sentById,
      },
    });
    await linkEvidence(tx, { id: userId, ipAddress }, {
      evidenceId: data.idScanEvidenceId,
      entityType: "Member",
      entityId: created.id,
      kind: "PRIMARY",
      submissionKey: `MEMBER_REGISTRATION:${created.id}`,
    });
    await tx.invitation.update({ where: { id: invitation.id }, data: { registeredAt: now } });
    await writeAudit(tx, {
      action: "member.register",
      entityType: "Member",
      entityId: created.id,
      userId,
      ipAddress,
      after: {
        fullName: data.fullName,
        phone: invitation.phone,
        moaumIdNumber: data.moaumIdNumber,
        consentVersion: CONSENT_VERSION,
        invitationId: invitation.id,
      },
    });
    return created;
  }, TX_OPTIONS);

  await notifyRegistration(db, member.id, data.fullName, invitation.phone);
  await queueForUser(db, invitation.sentById, {
    key: `invitee.registered:${member.id}`,
    template: "staff.invitee.registered",
    subject: `${data.fullName} registered`,
    text: `${data.fullName}, whom you invited, has registered and waits for a Loan Officer's review.`,
  });
  deliverSoon(db);
  return member;
}

export const activationSchema = z
  .object({
    password: z.string().min(10, "Use at least 10 characters.").max(128),
    confirmPassword: z.string(),
    consent: z.literal(true, { message: "You must accept the data protection notice to continue." }),
    /** Optional: completes KYC when the imported record has no ID scan. */
    idScanEvidenceId: z
      .string()
      .transform((v) => (v === "" ? null : v))
      .pipe(z.uuid().nullable()),
  })
  .refine((v) => v.password === v.confirmPassword, { message: "The two passwords don't match.", path: ["confirmPassword"] });

export type ActivationInput = z.input<typeof activationSchema>;

/** The imported member an ACTIVATION link belongs to. */
export async function memberForActivation(db: Db, invitation: Invitation) {
  if (invitation.type !== "ACTIVATION") throw new MemberError("This link is for registering as a new member.");
  const member = await db.member.findUnique({ where: { invitationId: invitation.id } });
  if (!member) throw new MemberError("This link isn't linked to a membership. Ask MOAUM for a new one.");
  return member;
}

/**
 * Sets up the login of a member who was imported by Admin (PRD F5): consent,
 * password, phone verified by SMS code, and optionally their ID scan.
 */
export async function activateImportedMember(
  db: PrismaClient,
  token: string,
  input: ActivationInput & { code: string },
  deps: RegistrationDeps,
  ipAddress: string | null,
) {
  const invitation = await usableInvitation(db, token);
  const member = await memberForActivation(db, invitation);
  const parsed = activationSchema.safeParse(input);
  if (!parsed.success) throw new MemberError(parsed.error.issues[0]?.message ?? "Check the form.");
  const data = parsed.data;

  if (data.idScanEvidenceId) {
    const scan = await db.evidenceUpload.findFirst({
      where: { evidenceId: data.idScanEvidenceId, uploadedById: registrantActorId(invitation.id), finishedAt: { not: null } },
    });
    const file = scan ? await db.evidenceFile.findUnique({ where: { id: data.idScanEvidenceId } }) : null;
    if (!file || !["image/jpeg", "image/png", "application/pdf"].includes(file.mimeType)) {
      throw new MemberError("Upload a JPG, PNG or PDF scan of your MOAUM ID card.");
    }
  }
  if (await db.account.findFirst({ where: { userId: member.userId, providerId: "credential" } })) {
    throw new MemberError("This membership already has a login. Sign in instead.");
  }

  let compromised = false;
  try {
    compromised = await deps.isPasswordCompromised(data.password);
  } catch {
    throw new MemberError("We couldn't check your password right now (network problem). Please try again.");
  }
  if (compromised) throw new MemberError(COMPROMISED);
  if (!(await deps.verifyCode(invitation.phone, input.code.trim()))) {
    throw new MemberError("That code didn't work. Check the SMS or request a new code.");
  }

  const passwordHash = await deps.hashPassword(data.password);
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.account.create({
      data: { id: deps.newId(), userId: member.userId, providerId: "credential", accountId: member.userId, password: passwordHash },
    });
    await tx.user.update({ where: { id: member.userId }, data: { phoneNumberVerified: true } });
    await tx.member.update({
      where: { id: member.id },
      data: {
        consentAt: now,
        consentVersion: CONSENT_VERSION,
        ...(data.idScanEvidenceId && !member.idScanEvidenceId ? { idScanEvidenceId: data.idScanEvidenceId } : {}),
      },
    });
    if (data.idScanEvidenceId && !member.idScanEvidenceId) {
      await linkEvidence(tx, { id: member.userId, ipAddress }, {
        evidenceId: data.idScanEvidenceId,
        entityType: "Member",
        entityId: member.id,
        kind: "PRIMARY",
        submissionKey: `MEMBER_KYC:${member.id}`,
      });
    }
    await tx.invitation.update({ where: { id: invitation.id }, data: { registeredAt: now } });
    await writeAudit(tx, {
      action: "member.login_activated",
      entityType: "Member",
      entityId: member.id,
      userId: member.userId,
      ipAddress,
      after: { consentVersion: CONSENT_VERSION, idScanAdded: Boolean(data.idScanEvidenceId && !member.idScanEvidenceId) },
    });
  }, TX_OPTIONS);
  return member;
}

/** Tells the registrant their application arrived and alerts Loan Officers (PRD F5 DoD). */
async function notifyRegistration(db: Db, memberId: string, fullName: string, phone: string): Promise<void> {
  notifyInBackground(db, {
    idempotencyKey: `member.registered:${memberId}:member`,
    channel: "SMS",
    recipient: phone,
    template: "member.registration_received",
    retryable: true,
    text: `Thank you, ${fullName.split(" ")[0]}. Your MOAUM Credit Super Store registration was received and will be reviewed. We'll text you when it's done.`,
    payload: { memberId },
  });
  const officers = await db.userModuleRole.findMany({
    where: { role: "LOAN_OFFICER", revokedAt: null, user: { deactivatedAt: null } },
    select: { user: { select: { id: true, email: true } } },
  });
  for (const { user } of officers) {
    notifyInBackground(db, {
      idempotencyKey: `member.registered:${memberId}:officer:${user.id}`,
      channel: "EMAIL",
      recipient: user.email,
      template: "member.registration_to_review",
      retryable: true,
      subject: `New member registration: ${fullName}`,
      text: `${fullName} has registered and is waiting for review.\n\nReview it in Dommus Negotii: ${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/staff/members`,
      payload: { memberId },
    });
  }
}
