import type { PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { notifyInBackground } from "@/shell/notifications/notify";
import { assertNotSelfDealing } from "@/shell/rbac/permissions";
import { normalizeStaffNo } from "../remittance/payroll-voucher";
import { MemberError, type MemberActor } from "./invitations";

async function actorMemberId(db: Db, actor: MemberActor): Promise<string | null> {
  return (await db.member.findUnique({ where: { userId: actor.id }, select: { id: true } }))?.id ?? null;
}

async function pendingMember(db: Db, memberId: string) {
  const member = await db.member.findUnique({ where: { id: memberId } });
  if (!member) throw new MemberError("Member not found.");
  if (member.status !== "PENDING") throw new MemberError("Only a pending registration can be reviewed.");
  return member;
}

/** Loan Officer activates a pending member (PRD F5): status ACTIVE and the MEMBER role. */
export async function activateMember(
  db: PrismaClient,
  actor: MemberActor,
  memberId: string,
) {
  assertNotSelfDealing(await actorMemberId(db, actor), memberId);
  const member = await pendingMember(db, memberId);
  if (!member.idScanEvidenceId) throw new MemberError("Attach the ID card scan before activating (KYC incomplete).");
  if (member.remittanceSourceId && !member.payrollStaffNo) {
    throw new MemberError("Record the member's payroll staff number before activating: payroll files are matched on it.");
  }

  await db.$transaction(async (tx) => {
    await tx.member.update({
      where: { id: memberId },
      data: { status: "ACTIVE", reviewedById: actor.id, reviewedAt: new Date() },
    });
    await tx.userModuleRole.upsert({
      where: { userId_moduleCode_role: { userId: member.userId, moduleCode: "CREDIT", role: "MEMBER" } },
      create: { userId: member.userId, moduleCode: "CREDIT", role: "MEMBER", assignedById: actor.id },
      update: { revokedAt: null, assignedById: actor.id, assignedAt: new Date() },
    });
    await writeAudit(tx, {
      action: "member.activate",
      entityType: "Member",
      entityId: memberId,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      before: { status: "PENDING" },
      after: { status: "ACTIVE" },
    });
  }, TX_OPTIONS);

  notifyInBackground(db, {
    idempotencyKey: `member.activated:${memberId}`,
    channel: "SMS",
    recipient: member.phone,
    template: "member.activated",
    text: `Welcome to MOAUM Credit Super Store, ${member.fullName.split(" ")[0]}. Your membership is active. Sign in at ${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"} with your phone number.`,
    payload: { memberId },
  });
}

/** Loan Officer declines a pending registration with a reason (PRD F5). */
export async function declineMember(db: Db, actor: MemberActor, memberId: string, reason: string) {
  assertNotSelfDealing(await actorMemberId(db, actor), memberId);
  const trimmed = reason.trim();
  if (trimmed.length < 5) throw new MemberError("Give a reason the applicant can act on.");
  const member = await pendingMember(db, memberId);
  await db.member.update({
    where: { id: memberId },
    data: { status: "DECLINED", reviewedById: actor.id, reviewedAt: new Date(), declineReason: trimmed },
  });
  await writeAudit(db, {
    action: "member.decline",
    entityType: "Member",
    entityId: memberId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { status: "PENDING" },
    after: { status: "DECLINED", reason: trimmed },
  });
  notifyInBackground(db, {
    idempotencyKey: `member.declined:${memberId}`,
    channel: "SMS",
    recipient: member.phone,
    template: "member.declined",
    text: `Your MOAUM Credit Super Store registration was not approved: ${trimmed} Contact MOAUM if you have questions.`,
    payload: { memberId },
  });
}

/**
 * Loan Officer records (or corrects) the member's staff number on their
 * remittance source's payroll. Payroll vouchers are matched on it, so it is
 * unique per source and every change is audited.
 */
export async function setPayrollStaffNo(db: Db, actor: MemberActor, memberId: string, value: string) {
  assertNotSelfDealing(await actorMemberId(db, actor), memberId);
  const member = await db.member.findUnique({ where: { id: memberId }, include: { remittanceSource: true } });
  if (!member) throw new MemberError("Member not found.");
  if (!member.remittanceSourceId) throw new MemberError("This member pays directly, so has no payroll staff number.");
  const staffNo = normalizeStaffNo(value);
  if (!/^[A-Z0-9/-]{2,30}$/.test(staffNo)) throw new MemberError("Enter the staff number exactly as on the payroll, e.g. S03020.");
  if (staffNo === member.payrollStaffNo) return;
  const owner = await db.member.findFirst({ where: { remittanceSourceId: member.remittanceSourceId, payrollStaffNo: staffNo, NOT: { id: memberId } } });
  if (owner) throw new MemberError(`${staffNo} already belongs to ${owner.fullName} on ${member.remittanceSource?.code ?? "this source"}.`);
  await db.member.update({ where: { id: memberId }, data: { payrollStaffNo: staffNo } });
  await writeAudit(db, {
    action: "member.payrollStaffNo.set",
    entityType: "Member",
    entityId: memberId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { payrollStaffNo: member.payrollStaffNo },
    after: { payrollStaffNo: staffNo },
  });
}

/** Members for the directory. KYC fields only when the reader may see them. */
export async function listMembers(db: Db, includeKyc: boolean) {
  const rows = await db.member.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { remittanceSource: { select: { name: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    memberNo: m.memberNo,
    payrollStaffNo: m.payrollStaffNo,
    hasSource: m.remittanceSourceId !== null,
    fullName: m.fullName,
    phone: m.phone,
    status: m.status,
    remittanceSource: m.remittanceSource?.name ?? "Pays directly",
    createdAt: m.createdAt,
    kyc: includeKyc
      ? {
          email: m.email,
          address: m.address,
          moaumIdNumber: m.moaumIdNumber,
          idScanEvidenceId: m.idScanEvidenceId,
          nextOfKinName: m.nextOfKinName,
          nextOfKinPhone: m.nextOfKinPhone,
          consentAt: m.consentAt,
          declineReason: m.declineReason,
        }
      : null,
  }));
}
