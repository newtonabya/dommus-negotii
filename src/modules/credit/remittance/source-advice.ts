import type { PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { kobo, ZERO, type Kobo } from "@/lib/money";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { writeAudit } from "@/shell/audit/audit";
import { assertColumns, readTable } from "../imports/table";
import { ADVICE_COLUMNS } from "../imports/templates";
import { readPayrollVoucher } from "./payroll-voucher";
import { activeSource, membersByPayrollKey, naira, parseCount, parseMonth, positiveAmount, REMITTANCE_TX, RemittanceError, type RemittanceActor } from "./common";

export interface AdviceHeaderInput {
  remittanceSource: string;
  monthCovered: string;
  adviceReference: string;
  controlTotal: string;
  rowCount: string;
}

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

/**
 * Finance Manager uploads a Source Advice (PRD F9): what the payroll source
 * says it deducted per member for a month, with the source's own document as
 * evidence. All or nothing; every problem is listed.
 */
export async function uploadSourceAdvice(
  db: PrismaClient,
  store: EvidenceStore,
  actor: RemittanceActor,
  input: AdviceHeaderInput,
  rowsFile: UploadedFile,
  document: UploadedFile,
) {
  const source = await activeSource(db, input.remittanceSource);
  const monthCovered = parseMonth(input.monthCovered);
  const adviceReference = input.adviceReference.trim();
  if (adviceReference.length < 2 || adviceReference.length > 80) throw new RemittanceError("Advice reference: enter the reference on the source's document.");
  const total = positiveAmount(input.controlTotal);
  if ("error" in total) throw new RemittanceError(`Control total ${total.error}.`);
  const rowCount = parseCount(input.rowCount, "Row count");
  if (document.bytes.length === 0) throw new RemittanceError("Attach the original document received from the source.");

  const taken = await db.sourceAdvice.findUnique({
    where: { remittanceSourceId_adviceReference: { remittanceSourceId: source.id, adviceReference } },
  });
  if (taken) throw new RemittanceError(`Advice ${adviceReference} was already uploaded for ${source.code}.`);

  // The payroll voucher as it arrives, or the advice template.
  const voucher = await readPayrollVoucher(rowsFile.filename, rowsFile.bytes);
  if (voucher?.month && voucher.month !== monthCovered) {
    throw new RemittanceError(`The file is for ${voucher.month} ("${voucher.title}") but the month covered is ${monthCovered}.`);
  }
  let entries: Array<{ rowNo: number; key: string; name: string; amount: string }>;
  if (voucher) {
    entries = voucher.rows.map((r) => ({ rowNo: r.rowNo, key: r.staffNo, name: r.name, amount: r.amount }));
  } else {
    const table = await readTable(rowsFile.filename, rowsFile.bytes);
    assertColumns(table, ADVICE_COLUMNS.map((c) => c.name));
    entries = table.rows.map(({ rowNo, values }) => ({
      rowNo,
      key: (values.member_moaum_id ?? "").trim().toUpperCase(),
      name: (values.member_name ?? "").trim(),
      amount: values.amount ?? "",
    }));
  }
  const keyLabel = voucher ? "staff number" : "member_moaum_id";
  const byPayroll = voucher ? await membersByPayrollKey(db, source.id, entries.map((e) => e.key)) : new Map();
  const byMoaum = voucher
    ? new Map()
    : new Map(
        (
          await db.member.findMany({
            where: { moaumIdNumber: { in: entries.map((e) => e.key).filter(Boolean), mode: "insensitive" } },
            select: { moaumIdNumber: true },
          })
        ).map((m) => [m.moaumIdNumber.toUpperCase(), m]),
      );

  const errors: string[] = [];
  const parsed: Array<{ moaumIdNumber: string; memberName: string; amount: Kobo }> = [];
  const seen = new Map<string, number>();
  for (const e of entries) {
    const amount = positiveAmount(e.amount);
    if (!e.key) errors.push(`Row ${e.rowNo}: ${keyLabel} is empty.`);
    if (!e.name && !voucher) errors.push(`Row ${e.rowNo}: member_name is empty.`);
    if ("error" in amount) errors.push(`Row ${e.rowNo}: amount ${amount.error}.`);
    const member = voucher ? byPayroll.get(e.key) : byMoaum.get(e.key);
    if (e.key && !member) {
      errors.push(
        voucher
          ? `Row ${e.rowNo}: staff number ${e.key} (${e.name || "no name"}) is not linked to a member on ${source.code}. Record it on the member first.`
          : `Row ${e.rowNo}: member ${e.key} (${e.name}) is not in the register.`,
      );
    }
    const moaumIdNumber: string | undefined = member?.moaumIdNumber.toUpperCase();
    if (moaumIdNumber) {
      const first = seen.get(moaumIdNumber);
      if (first !== undefined) errors.push(`Row ${e.rowNo}: the same member as row ${first}; one row per member.`);
      else seen.set(moaumIdNumber, e.rowNo);
    }
    if (moaumIdNumber && "value" in amount) parsed.push({ moaumIdNumber, memberName: e.name || (member?.fullName ?? ""), amount: amount.value });
  }
  if (entries.length === 0) errors.push("The file has no rows.");
  const sum = parsed.reduce((t, p) => kobo(t + p.amount), ZERO);
  if (errors.length === 0 && sum !== total.value) errors.push(`The rows total ${naira(sum)} but the control total is ${naira(total.value)}.`);
  if (errors.length === 0 && entries.length !== rowCount) errors.push(`The file has ${entries.length} rows but the row count is ${rowCount}.`);
  if (errors.length > 0) throw new RemittanceError("The advice was not saved. Fix these and upload again:", errors);

  const original = await storeEvidenceBytes(db, store, actor, document.filename, document.bytes);
  const sheet = await storeEvidenceBytes(db, store, actor, rowsFile.filename, rowsFile.bytes);
  return db.$transaction(async (tx) => {
    const advice = await tx.sourceAdvice.create({
      data: {
        remittanceSourceId: source.id,
        monthCovered,
        adviceReference,
        controlTotal: total.value,
        rowCount,
        evidenceId: original.evidenceId,
        uploadedById: actor.id,
        rows: { createMany: { data: parsed.map((p) => ({ moaumIdNumber: p.moaumIdNumber, memberName: p.memberName, amount: p.amount })) } },
      },
    });
    const submissionKey = `SOURCE_ADVICE:${advice.id}`;
    await linkEvidence(tx, actor, { evidenceId: original.evidenceId, entityType: "SourceAdvice", entityId: advice.id, kind: "PRIMARY", submissionKey });
    if (sheet.evidenceId !== original.evidenceId) {
      await linkEvidence(tx, actor, { evidenceId: sheet.evidenceId, entityType: "SourceAdvice", entityId: advice.id, kind: "SUPPORTING", submissionKey });
    }
    await writeAudit(tx, {
      action: "sourceAdvice.upload",
      entityType: "SourceAdvice",
      entityId: advice.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: original.evidenceId,
      after: { source: source.code, monthCovered, adviceReference, controlTotal: total.value.toString(), rowCount, checksum: original.sha256 },
    });
    return advice;
  }, REMITTANCE_TX);
}

/** Recent advices, newest first, with whether a schedule has used them. */
export async function listAdvices(db: Db, take = 50) {
  return db.sourceAdvice.findMany({
    orderBy: { uploadedAt: "desc" },
    take,
    include: { remittanceSource: { select: { code: true, name: true } }, schedule: { select: { id: true, scheduleReference: true } } },
  });
}
