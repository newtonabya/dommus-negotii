import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { writeAudit } from "@/shell/audit/audit";
import { flagDuplicates, loadPreviewedBatch, saveBatch, type PreviewRow } from "../imports/batches";
import { assertColumns, readTable } from "../imports/table";
import { MEMBER_COLUMNS } from "../imports/templates";
import { deliverInvitation, invitationExpiry, MemberError, newInvitationToken, type MemberActor } from "./invitations";
import { normalizeStaffNo } from "../remittance/payroll-voucher";
import { moaumId, optionalEmail, phoneField, placeholderEmail } from "./rules";

/** Bulk imports write many rows in one transaction. */
const IMPORT_TX = { maxWait: 15_000, timeout: 120_000 } as const;

const rowSchema = z.object({
  fullName: z.string().trim().min(3, "full_name: enter the full name.").max(120),
  phone: phoneField,
  email: optionalEmail,
  address: z.string().trim().min(5, "address: enter the home address.").max(300),
  moaumIdNumber: moaumId,
  nextOfKinName: z.string().trim().min(3, "next_of_kin_name: enter the next of kin's name.").max(120),
  nextOfKinPhone: phoneField,
});

export interface ImportedMemberRow extends z.output<typeof rowSchema> {
  remittanceSourceId: string | null;
  /** Staff number on the source's payroll; remittance files are matched on it. */
  payrollStaffNo: string | null;
}

async function checkAgainstDatabase(db: Db, rows: PreviewRow<ImportedMemberRow>[]): Promise<void> {
  const valid = rows.filter((r) => r.errors.length === 0);
  const phones = valid.map((r) => r.data.phone);
  const ids = valid.map((r) => r.data.moaumIdNumber);
  const emails = valid.map((r) => r.data.email ?? placeholderEmail(r.data.phone));
  const staffKeys = valid.filter((r) => r.data.payrollStaffNo && r.data.remittanceSourceId);
  const takenStaff = staffKeys.length
    ? await db.member.findMany({
        where: { OR: staffKeys.map((r) => ({ remittanceSourceId: r.data.remittanceSourceId, payrollStaffNo: r.data.payrollStaffNo })) },
        select: { remittanceSourceId: true, payrollStaffNo: true, fullName: true },
      })
    : [];
  const staffOwner = new Map(takenStaff.map((m) => [`${m.remittanceSourceId}|${m.payrollStaffNo}`, m.fullName]));
  for (const row of staffKeys) {
    const owner = staffOwner.get(`${row.data.remittanceSourceId}|${row.data.payrollStaffNo}`);
    if (owner) row.errors.push(`payroll_staff_no: ${row.data.payrollStaffNo} already belongs to ${owner} on this source.`);
  }
  const [members, memberIds, users, userEmails, invitations] = await Promise.all([
    db.member.findMany({ where: { phone: { in: phones } }, select: { phone: true } }),
    db.member.findMany({ where: { moaumIdNumber: { in: ids } }, select: { moaumIdNumber: true } }),
    db.user.findMany({ where: { phoneNumber: { in: phones } }, select: { phoneNumber: true } }),
    db.user.findMany({ where: { email: { in: emails } }, select: { email: true } }),
    db.invitation.findMany({
      where: { phone: { in: phones }, registeredAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { phone: true },
    }),
  ]);
  const has = <T>(list: T[], pick: (t: T) => string | null) => new Set(list.map(pick));
  const memberPhones = has(members, (m) => m.phone);
  const takenIds = has(memberIds, (m) => m.moaumIdNumber);
  const userPhones = has(users, (u) => u.phoneNumber);
  const takenEmails = has(userEmails, (u) => u.email);
  const invited = has(invitations, (i) => i.phone);
  for (const row of valid) {
    if (memberPhones.has(row.data.phone)) row.errors.push("phone: already a member.");
    else if (userPhones.has(row.data.phone)) row.errors.push("phone: already has a portal login.");
    if (invited.has(row.data.phone)) row.errors.push("phone: has an open invitation. Revoke it first.");
    if (takenIds.has(row.data.moaumIdNumber)) row.errors.push("moaum_id_number: already belongs to a member.");
    if (row.data.email && takenEmails.has(row.data.email)) row.errors.push("email: already used by another login.");
  }
}

async function validateRows(db: Db, rawRows: Array<{ rowNo: number; values: Record<string, string> }>) {
  const sources = await db.remittanceSource.findMany();
  const byCode = new Map(sources.map((s) => [s.code.toUpperCase(), s]));

  const rows: PreviewRow<ImportedMemberRow>[] = rawRows.map(({ rowNo, values }) => {
    const errors: string[] = [];
    const parsed = rowSchema.safeParse({
      fullName: values.full_name ?? "",
      phone: values.phone ?? "",
      email: values.email ?? "",
      address: values.address ?? "",
      moaumIdNumber: values.moaum_id_number ?? "",
      nextOfKinName: values.next_of_kin_name ?? "",
      nextOfKinPhone: values.next_of_kin_phone ?? "",
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        const column = { phone: "phone", nextOfKinPhone: "next_of_kin_phone", moaumIdNumber: "moaum_id_number", email: "email" }[field];
        errors.push(column && !issue.message.includes(":") ? `${column}: ${issue.message}` : issue.message);
      }
    }
    const code = (values.remittance_source_code ?? "").trim().toUpperCase();
    let remittanceSourceId: string | null = null;
    if (code === "") errors.push("remittance_source_code: enter a source code, or NONE if they pay directly.");
    else if (code !== "NONE") {
      const source = byCode.get(code);
      if (!source) errors.push(`remittance_source_code: unknown code "${code}".`);
      else if (!source.active) errors.push(`remittance_source_code: ${code} is switched off.`);
      else remittanceSourceId = source.id;
    }
    const payrollStaffNo = normalizeStaffNo(values.payroll_staff_no ?? "") || null;
    if (remittanceSourceId && !payrollStaffNo) errors.push("payroll_staff_no: enter the member's staff number on the payroll (it is how remittance files find them).");
    if (!remittanceSourceId && payrollStaffNo) errors.push("payroll_staff_no: leave empty for members who pay directly.");
    const data = parsed.success
      ? { ...parsed.data, remittanceSourceId, payrollStaffNo }
      : ({ fullName: values.full_name ?? "", phone: values.phone ?? "" } as ImportedMemberRow);
    return { rowNo, raw: values, data, errors };
  });

  flagDuplicates(rows, (r) => (r.errors.length ? null : r.data.phone), "phone number");
  flagDuplicates(rows, (r) => (r.errors.length ? null : r.data.moaumIdNumber), "MOAUM ID number");
  flagDuplicates(rows, (r) => (r.errors.length || !r.data.payrollStaffNo ? null : `${r.data.remittanceSourceId}|${r.data.payrollStaffNo}`), "payroll staff number");
  flagDuplicates(rows, (r) => (r.errors.length || !r.data.email ? null : r.data.email), "email");
  await checkAgainstDatabase(db, rows);
  return rows;
}

/** Dry run of a member import (PRD F5): checks every row, stores the file as evidence and the per-row log. */
export async function previewMemberImport(
  db: Db,
  store: EvidenceStore,
  actor: MemberActor,
  filename: string,
  bytes: Uint8Array,
) {
  const table = await readTable(filename, bytes);
  assertColumns(table, MEMBER_COLUMNS.filter((c) => c.required).map((c) => c.name));
  if (table.rows.length === 0) throw new MemberError("The file has no member rows.");
  const rows = await validateRows(db, table.rows);
  const evidence = await storeEvidenceBytes(db, store, actor, filename, bytes);
  const batch = await saveBatch(db, { kind: "MEMBERS", filename, evidenceId: evidence.evidenceId, uploadedById: actor.id, rows });
  return {
    batchId: batch.id,
    rows: rows.map((r) => ({ rowNo: r.rowNo, fullName: r.data.fullName, phone: r.data.phone, errors: r.errors })),
    validCount: rows.filter((r) => r.errors.length === 0).length,
  };
}

/**
 * Commits a previewed import, all or nothing (PRD F5): ACTIVE members with a
 * login and the MEMBER role, plus an ACTIVATION invitation each, then texts
 * every member their link.
 */
export async function commitMemberImport(db: PrismaClient, actor: MemberActor, batchId: string) {
  const batch = await loadPreviewedBatch(db, batchId, "MEMBERS", actor.id);
  if (!batch) throw new MemberError("This import was already committed or has expired. Upload the file again.");

  // Re-check now: members may have registered since the dry run.
  const rows = await validateRows(
    db,
    batch.rows.map((r) => ({ rowNo: r.rowNo, values: (r.data as { raw: Record<string, string> }).raw })),
  );
  const errorRows = rows.filter((r) => r.errors.length > 0);
  if (errorRows.length > 0) {
    await db.$transaction([
      ...errorRows.map((r) =>
        db.importRowLog.update({ where: { batchId_rowNo: { batchId: batch.id, rowNo: r.rowNo } }, data: { errors: r.errors } }),
      ),
      db.importBatch.update({ where: { id: batch.id }, data: { status: "REJECTED", errorRowCount: errorRows.length } }),
    ]);
    throw new MemberError(`Nothing was imported: ${errorRows.length} row${errorRows.length === 1 ? " has" : "s have"} errors. Fix the file and upload it again.`);
  }

  const now = new Date();
  const expiresAt = await invitationExpiry(db, now);
  const planned = rows.map((r) => {
    const { token, tokenHash } = newInvitationToken();
    return { row: r, token, tokenHash, userId: randomUUID().replace(/-/g, ""), memberId: randomUUID(), invitationId: randomUUID() };
  });

  await db.$transaction(async (tx) => {
    await tx.user.createMany({
      data: planned.map((p) => ({
        id: p.userId,
        name: p.row.data.fullName,
        email: p.row.data.email ?? placeholderEmail(p.row.data.phone),
        emailVerified: false,
        phoneNumber: p.row.data.phone,
        phoneNumberVerified: false,
      })),
    });
    await tx.invitation.createMany({
      data: planned.map((p) => ({
        id: p.invitationId,
        type: "ACTIVATION" as const,
        fullName: p.row.data.fullName,
        phone: p.row.data.phone,
        email: p.row.data.email,
        remittanceSourceId: p.row.data.remittanceSourceId,
        tokenHash: p.tokenHash,
        expiresAt,
        sentById: actor.id,
      })),
    });
    await tx.member.createMany({
      data: planned.map((p) => ({
        id: p.memberId,
        userId: p.userId,
        fullName: p.row.data.fullName,
        phone: p.row.data.phone,
        email: p.row.data.email,
        address: p.row.data.address,
        moaumIdNumber: p.row.data.moaumIdNumber,
        nextOfKinName: p.row.data.nextOfKinName,
        nextOfKinPhone: p.row.data.nextOfKinPhone,
        remittanceSourceId: p.row.data.remittanceSourceId,
        payrollStaffNo: p.row.data.payrollStaffNo,
        status: "ACTIVE" as const,
        invitationId: p.invitationId,
        invitedById: actor.id,
        reviewedById: actor.id,
        reviewedAt: now,
      })),
    });
    await tx.userModuleRole.createMany({
      data: planned.map((p) => ({ userId: p.userId, moduleCode: "CREDIT", role: "MEMBER" as const, assignedById: actor.id })),
    });
    if (batch.evidenceId) {
      await tx.evidenceLink.createMany({
        data: planned.map((p) => ({
          evidenceId: batch.evidenceId as string,
          entityType: "Member",
          entityId: p.memberId,
          kind: "PRIMARY" as const,
          submissionKey: `MEMBER_IMPORT:${batch.id}`,
          linkedById: actor.id,
        })),
      });
    }
    for (const p of planned) {
      await tx.importRowLog.update({
        where: { batchId_rowNo: { batchId: batch.id, rowNo: p.row.rowNo } },
        data: { entityId: p.memberId },
      });
    }
    await tx.importBatch.update({
      where: { id: batch.id },
      data: { status: "COMMITTED", committedById: actor.id, committedAt: now, errorRowCount: 0 },
    });
    await writeAudit(tx, {
      action: "member.import.commit",
      entityType: "ImportBatch",
      entityId: batch.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: batch.evidenceId,
      after: { filename: batch.filename, members: planned.length },
    });
  }, IMPORT_TX);

  // Activation links go out only after the import is safely committed.
  let smsFailed = 0;
  const invitations = await db.invitation.findMany({ where: { id: { in: planned.map((p) => p.invitationId) } } });
  const byId = new Map(invitations.map((i) => [i.id, i]));
  for (const p of planned) {
    const invitation = byId.get(p.invitationId);
    if (!invitation) continue;
    const sent = await deliverInvitation(db, invitation, p.token).catch(() => false);
    if (!sent) {
      smsFailed++;
      await db.invitation.update({ where: { id: invitation.id }, data: { lastSendOk: false } });
    }
  }
  return { imported: planned.length, smsFailed };
}
