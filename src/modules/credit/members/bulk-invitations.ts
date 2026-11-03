import type { Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { flagDuplicates, loadPreviewedBatch, saveBatch, type PreviewRow } from "../imports/batches";
import { assertColumns, readTable } from "../imports/table";
import { createInvitation, MemberError, type MemberActor } from "./invitations";
import { getCountSetting } from "@/shell/settings/settings";
import { invitationSchema } from "./rules";

export interface BulkInvitationRow {
  fullName: string;
  phone: string;
  email: string | null;
  remittanceSourceId: string | null;
}

/** Looks up remittance sources by code; NONE or empty means none. */
async function sourceResolver(db: Db) {
  const sources = await db.remittanceSource.findMany();
  const byCode = new Map(sources.map((s) => [s.code.toUpperCase(), s]));
  return (code: string): { id: string | null; error?: string } => {
    const c = code.trim().toUpperCase();
    if (c === "" || c === "NONE") return { id: null };
    const source = byCode.get(c);
    if (!source) return { id: null, error: `Unknown remittance source code "${code}".` };
    if (!source.active) return { id: null, error: `Remittance source ${c} is switched off.` };
    return { id: source.id };
  };
}

/**
 * Dry run for a list of invitations (PRD F5): checks every row and saves the
 * per-row log. Nothing is sent.
 */
export async function previewBulkInvitations(db: Db, actor: MemberActor, filename: string, bytes: Uint8Array) {
  const table = await readTable(filename, bytes);
  assertColumns(table, ["full_name", "phone"]);
  const resolveSource = await sourceResolver(db);

  const rows: PreviewRow<BulkInvitationRow>[] = table.rows.map(({ rowNo, values }) => {
    const errors: string[] = [];
    const source = resolveSource(values.remittance_source_code ?? "");
    if (source.error) errors.push(source.error);
    const parsed = invitationSchema.safeParse({
      fullName: values.full_name ?? "",
      phone: values.phone ?? "",
      email: values.email ?? "",
      remittanceSourceId: source.id ?? "",
    });
    if (!parsed.success) errors.push(...parsed.error.issues.map((i) => i.message));
    const data = parsed.success ? parsed.data : { fullName: values.full_name ?? "", phone: values.phone ?? "", email: null, remittanceSourceId: null };
    return { rowNo, raw: values, data, errors };
  });

  flagDuplicates(rows, (r) => (r.errors.length ? null : r.data.phone), "phone number");

  const phones = rows.filter((r) => r.errors.length === 0).map((r) => r.data.phone);
  const [members, users, openInvitations] = await Promise.all([
    db.member.findMany({ where: { phone: { in: phones } }, select: { phone: true } }),
    db.user.findMany({ where: { phoneNumber: { in: phones } }, select: { phoneNumber: true } }),
    db.invitation.findMany({
      where: { phone: { in: phones }, registeredAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { phone: true },
    }),
  ]);
  const memberPhones = new Set(members.map((m) => m.phone));
  const userPhones = new Set(users.map((u) => u.phoneNumber));
  const invitedPhones = new Set(openInvitations.map((i) => i.phone));
  for (const row of rows) {
    if (row.errors.length) continue;
    if (memberPhones.has(row.data.phone)) row.errors.push("Already a member or a pending registration.");
    else if (userPhones.has(row.data.phone)) row.errors.push("This number already has a portal login.");
    else if (invitedPhones.has(row.data.phone)) row.errors.push("Already has an open invitation.");
  }

  const sentToday = await db.auditLog.count({
    where: { action: "invitation.sent", userId: actor.id, occurredAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  const perDay = await getCountSetting(db, "max_invites_per_sender_per_day");
  let remaining = Math.max(0, perDay - sentToday);
  for (const row of rows) {
    if (row.errors.length) continue;
    if (remaining === 0) row.errors.push(`Over your limit of ${perDay} invitations a day. Send this row tomorrow.`);
    else remaining--;
  }

  const batch = await saveBatch(db, { kind: "INVITATIONS", filename, evidenceId: null, uploadedById: actor.id, rows });
  return {
    batchId: batch.id,
    rows: rows.map((r) => ({ rowNo: r.rowNo, fullName: r.data.fullName, phone: r.data.phone, errors: r.errors })),
    validCount: rows.filter((r) => r.errors.length === 0).length,
  };
}

/** Sends the valid rows of a previewed list. Rows that fail now get the reason in their log. */
export async function sendBulkInvitations(db: Db, actor: MemberActor, batchId: string) {
  const batch = await loadPreviewedBatch(db, batchId, "INVITATIONS", actor.id);
  if (!batch) throw new MemberError("This list was already sent or has expired. Upload it again.");

  let sent = 0;
  const failed: Array<{ rowNo: number; error: string }> = [];
  for (const row of batch.rows) {
    if (row.errors.length) continue;
    const parsed = (row.data as { parsed: BulkInvitationRow | null }).parsed;
    if (!parsed) continue;
    try {
      const { invitation, sent: delivered } = await createInvitation(db, actor, {
        fullName: parsed.fullName,
        phone: parsed.phone,
        email: parsed.email ?? "",
        remittanceSourceId: parsed.remittanceSourceId ?? "",
      });
      await db.importRowLog.update({ where: { id: row.id }, data: { entityId: invitation.id } });
      if (delivered) sent++;
      else failed.push({ rowNo: row.rowNo, error: "Saved, but the SMS provider didn't accept the message. Resend it from the list." });
    } catch (error) {
      const message = error instanceof MemberError ? error.message : "Couldn't send this invitation.";
      if (!(error instanceof MemberError)) console.error("[bulk invitations]", error);
      await db.importRowLog.update({ where: { id: row.id }, data: { errors: [message] } });
      failed.push({ rowNo: row.rowNo, error: message });
    }
  }
  await db.importBatch.update({
    where: { id: batch.id },
    data: { status: "COMMITTED", committedById: actor.id, committedAt: new Date() },
  });
  await writeAudit(db, {
    action: "invitation.bulk_send",
    entityType: "ImportBatch",
    entityId: batch.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { filename: batch.filename, sent, failed: failed.length },
  });
  return { sent, failed };
}
