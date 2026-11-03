import { z } from "zod";
import { Prisma, type Member, type PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { linkEvidence } from "@/evidence/service";
import { writeAudit } from "@/shell/audit/audit";
import { MemberError, type MemberActor } from "./invitations";
import { consumePhoneChangeCode } from "./phone-change";
import { moaumId, optionalEmail, phoneField, placeholderEmail } from "./rules";

/**
 * Member profile change requests (PRD F5): the member asks, the Loan Officer
 * approves. A new phone must be confirmed by SMS code first; a new name or
 * MOAUM ID number needs a supporting document, and a new ID scan is its own.
 */
export const PROFILE_FIELDS = {
  fullName: "Full name",
  phone: "Phone",
  email: "Email",
  address: "Address",
  moaumIdNumber: "MOAUM ID number",
  idScanEvidenceId: "ID card scan",
  nextOfKinName: "Next of kin",
  nextOfKinPhone: "Next of kin's phone",
  remittanceSourceId: "Remittance source",
} as const;

export type ProfileField = keyof typeof PROFILE_FIELDS;
export type ProfileValues = Partial<Record<ProfileField, string | null>>;

const NEEDS_DOCUMENT: readonly ProfileField[] = ["fullName", "moaumIdNumber"];
const SCAN_TYPES = ["image/jpeg", "image/png", "application/pdf"];

const fieldSchemas: Record<ProfileField, z.ZodType<string | null>> = {
  fullName: z.string().trim().min(3, "Enter your full name.").max(120),
  phone: phoneField,
  email: optionalEmail,
  address: z.string().trim().min(10, "Enter your full address.").max(300),
  moaumIdNumber: moaumId,
  idScanEvidenceId: z.uuid({ message: "Upload the scan again." }),
  nextOfKinName: z.string().trim().min(3, "Enter your next of kin's full name.").max(120),
  nextOfKinPhone: phoneField,
  remittanceSourceId: z
    .string()
    .transform((v) => (v === "" || v === "NONE" ? null : v))
    .pipe(z.uuid().nullable()),
};

function currentValues(member: Member): Record<ProfileField, string | null> {
  return {
    fullName: member.fullName,
    phone: member.phone,
    email: member.email,
    address: member.address,
    moaumIdNumber: member.moaumIdNumber,
    idScanEvidenceId: member.idScanEvidenceId,
    nextOfKinName: member.nextOfKinName,
    nextOfKinPhone: member.nextOfKinPhone,
    remittanceSourceId: member.remittanceSourceId,
  };
}

/** Uniqueness and reference checks for the fields being changed, run at request and again at approval. */
async function checkChanges(db: Db, member: Member, changes: ProfileValues): Promise<void> {
  if (changes.phone) {
    if ((await db.member.findFirst({ where: { phone: changes.phone, NOT: { id: member.id } } })) ||
        (await db.user.findFirst({ where: { phoneNumber: changes.phone, NOT: { id: member.userId } } }))) {
      throw new MemberError("That phone number belongs to another member or login.");
    }
  }
  if (changes.moaumIdNumber && (await db.member.findFirst({ where: { moaumIdNumber: changes.moaumIdNumber, NOT: { id: member.id } } }))) {
    throw new MemberError("That MOAUM ID number belongs to another member.");
  }
  if (changes.email && (await db.user.findFirst({ where: { email: changes.email, NOT: { id: member.userId } } }))) {
    throw new MemberError("That email address is used by another login.");
  }
  if (changes.remittanceSourceId) {
    const source = await db.remittanceSource.findUnique({ where: { id: changes.remittanceSourceId } });
    if (!source?.active) throw new MemberError("Choose a remittance source from the list.");
  }
}

/** The file must have been uploaded by this member and finished. */
async function ownUpload(db: Db, userId: string, evidenceId: string, types?: string[]) {
  const upload = await db.evidenceUpload.findFirst({ where: { evidenceId, uploadedById: userId, finishedAt: { not: null } } });
  const file = upload ? await db.evidenceFile.findUnique({ where: { id: evidenceId } }) : null;
  if (!file || (types && !types.includes(file.mimeType))) return null;
  return file;
}

export interface ProfileChangeInput {
  values: Record<string, string>;
  note?: string;
  evidenceId?: string;
  phoneCode?: string;
}

/** A member asks for changes; only fields that differ are kept. */
export async function requestProfileChange(db: Db, actor: MemberActor, input: ProfileChangeInput) {
  const member = await db.member.findUnique({ where: { userId: actor.id } });
  if (!member) throw new MemberError("No membership is linked to this login.");
  if (member.status !== "ACTIVE") throw new MemberError("Only active members can request changes.");

  const current = currentValues(member);
  const changes: ProfileValues = {};
  for (const field of Object.keys(PROFILE_FIELDS) as ProfileField[]) {
    const raw = input.values[field];
    if (raw === undefined) continue;
    if (field === "idScanEvidenceId" && raw === "") continue;
    const parsed = fieldSchemas[field].safeParse(raw);
    if (!parsed.success) throw new MemberError(`${PROFILE_FIELDS[field]}: ${parsed.error.issues[0]?.message ?? "check this field."}`);
    if (parsed.data !== current[field]) changes[field] = parsed.data;
  }
  const fields = Object.keys(changes) as ProfileField[];
  if (fields.length === 0) throw new MemberError("Nothing has changed.");

  await checkChanges(db, member, changes);
  let phoneVerifiedAt: Date | null = null;
  if (changes.phone) {
    if (!input.phoneCode || !(await consumePhoneChangeCode(db, actor.id, changes.phone, input.phoneCode))) {
      throw new MemberError("Confirm the new phone number with the code we texted to it.");
    }
    phoneVerifiedAt = new Date();
  }
  if (changes.idScanEvidenceId) {
    if (!(await ownUpload(db, actor.id, changes.idScanEvidenceId, SCAN_TYPES))) throw new MemberError("Upload a JPG, PNG or PDF of your ID card.");
  }
  const evidenceId = input.evidenceId?.trim() || null;
  if (evidenceId && !(await ownUpload(db, actor.id, evidenceId))) throw new MemberError("Upload the supporting document again.");
  if (fields.some((f) => NEEDS_DOCUMENT.includes(f)) && !evidenceId) {
    throw new MemberError("Changing your name or MOAUM ID number needs a supporting document (e.g. a sworn affidavit or the new ID card).");
  }

  const before = Object.fromEntries(fields.map((f) => [f, current[f]]));
  let request;
  try {
    request = await db.profileChangeRequest.create({
      data: {
        memberId: member.id,
        changes: changes as Prisma.InputJsonObject,
        before: before as Prisma.InputJsonObject,
        note: input.note?.trim() || null,
        evidenceId,
        phoneVerifiedAt,
        requestedById: actor.id,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new MemberError("You already have a request waiting for review. Withdraw it first to change it.");
    }
    throw error;
  }
  for (const [id, kind] of [
    [changes.idScanEvidenceId, "SUPPORTING"],
    [evidenceId, "SUPPORTING"],
  ] as const) {
    if (id) {
      await linkEvidence(db, actor, { evidenceId: id, entityType: "ProfileChangeRequest", entityId: request.id, kind, submissionKey: `PROFILE_CHANGE:${request.id}` });
    }
  }
  await writeAudit(db, {
    action: "member.profile_change.requested",
    entityType: "ProfileChangeRequest",
    entityId: request.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    evidenceRef: evidenceId,
    before,
    after: { ...changes, memberId: member.id },
  });
  return request;
}

async function pendingRequest(db: Db, requestId: string) {
  const request = await db.profileChangeRequest.findUnique({ where: { id: requestId }, include: { member: true } });
  if (!request) throw new MemberError("Request not found.");
  if (request.status !== "PENDING") throw new MemberError(`This request was already ${request.status.toLowerCase()}.`);
  return request;
}

/** The Loan Officer approves: the member record (and login) take the new values in one transaction. */
export async function approveProfileChange(db: PrismaClient, actor: MemberActor, requestId: string, note = "") {
  const request = await pendingRequest(db, requestId);
  const member = request.member;
  if (member.userId === actor.id) throw new MemberError("You can't approve a change to your own membership.");
  const changes = request.changes as ProfileValues;
  await checkChanges(db, member, changes);

  await db.$transaction(async (tx) => {
    const { count } = await tx.profileChangeRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note.trim() || null },
    });
    if (count !== 1) throw new MemberError("This request was decided by someone else just now.");

    await tx.member.update({ where: { id: member.id }, data: changes as Prisma.MemberUncheckedUpdateInput });

    const user = await tx.user.findUniqueOrThrow({ where: { id: member.userId } });
    const phone = changes.phone ?? member.phone;
    const hadPlaceholder = user.email === placeholderEmail(member.phone);
    const login: Prisma.UserUpdateInput = {};
    if (changes.fullName) login.name = changes.fullName;
    if (changes.phone) Object.assign(login, { phoneNumber: changes.phone, phoneNumberVerified: true });
    if ("email" in changes) login.email = changes.email ?? placeholderEmail(phone);
    else if (changes.phone && hadPlaceholder) login.email = placeholderEmail(phone);
    if (Object.keys(login).length > 0) await tx.user.update({ where: { id: member.userId }, data: login });

    if (changes.idScanEvidenceId) {
      await linkEvidence(tx, actor, {
        evidenceId: changes.idScanEvidenceId,
        entityType: "Member",
        entityId: member.id,
        kind: "PRIMARY",
        submissionKey: `MEMBER_KYC:${member.id}`,
        duplicateReason: "Replacement ID card scan approved through a profile change request.",
      });
    }
    await writeAudit(tx, {
      action: "member.profile_change.approved",
      entityType: "Member",
      entityId: member.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: request.evidenceId,
      before: request.before,
      after: { ...changes, requestId },
    });
  }, TX_OPTIONS);
}

/** The Loan Officer rejects, with a reason the member sees. */
export async function rejectProfileChange(db: Db, actor: MemberActor, requestId: string, note: string) {
  const request = await pendingRequest(db, requestId);
  if (request.member.userId === actor.id) throw new MemberError("You can't decide a change to your own membership.");
  const reason = note.trim();
  if (reason.length < 5) throw new MemberError("Say why you're rejecting it (the member will see this).");
  const { count } = await db.profileChangeRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "REJECTED", decidedById: actor.id, decidedAt: new Date(), decisionNote: reason },
  });
  if (count !== 1) throw new MemberError("This request was decided by someone else just now.");
  await writeAudit(db, {
    action: "member.profile_change.rejected",
    entityType: "ProfileChangeRequest",
    entityId: requestId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { memberId: request.memberId, note: reason },
  });
}

/** The member takes back their own open request. */
export async function withdrawProfileChange(db: Db, actor: MemberActor, requestId: string) {
  const request = await pendingRequest(db, requestId);
  if (request.member.userId !== actor.id) throw new MemberError("Request not found.");
  await db.profileChangeRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
  await writeAudit(db, {
    action: "member.profile_change.withdrawn",
    entityType: "ProfileChangeRequest",
    entityId: requestId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
  });
}

/** Display text for a field value: source names instead of ids, "Not given" for blanks. */
export async function describeValues(db: Db, values: ProfileValues) {
  const sourceIds = [values.remittanceSourceId].filter((v): v is string => Boolean(v));
  const sources = sourceIds.length ? await db.remittanceSource.findMany({ where: { id: { in: sourceIds } } }) : [];
  return (Object.keys(values) as ProfileField[]).map((field) => {
    const v = values[field];
    let text = v ?? "Not given";
    if (field === "remittanceSourceId") text = v ? (sources.find((s) => s.id === v)?.name ?? "Unknown source") : "None — pays directly";
    if (field === "idScanEvidenceId") text = v ? "New scan attached" : "None";
    return { field, label: PROFILE_FIELDS[field], value: v ?? null, text };
  });
}

/** Open requests for the Loan Officer, oldest first. */
export async function listPendingProfileChanges(db: Db) {
  const requests = await db.profileChangeRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { requestedAt: "asc" },
    include: { member: { select: { id: true, fullName: true, phone: true, moaumIdNumber: true, userId: true } } },
  });
  return Promise.all(
    requests.map(async (r) => {
      const before = r.before as ProfileValues;
      const after = await describeValues(db, r.changes as ProfileValues);
      const was = await describeValues(db, before);
      return { ...r, diff: after.map((a) => ({ ...a, was: was.find((w) => w.field === a.field)?.text ?? "Not given" })) };
    }),
  );
}

/** The member's own requests, newest first, for their profile page. */
export async function memberRequests(db: Db, memberId: string) {
  const requests = await db.profileChangeRequest.findMany({ where: { memberId }, orderBy: { requestedAt: "desc" }, take: 20 });
  return Promise.all(requests.map(async (r) => ({ ...r, items: await describeValues(db, r.changes as ProfileValues) })));
}
